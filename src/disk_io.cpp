// Completions post onto the io_context, so the callback runs on the libtorrent thread, holding none of our locks.

#include "disk_io.hpp"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <variant>
#include <vector>

#include "libtorrent/disk_buffer_holder.hpp"
#include "libtorrent/error_code.hpp"
#include "libtorrent/file_storage.hpp"
#include "libtorrent/hasher.hpp"
#include "libtorrent/peer_request.hpp"
#include "libtorrent/performance_counters.hpp"
#include "libtorrent/storage_defs.hpp"
#include "libtorrent/units.hpp"
#include "libtorrent/aux_/vector.hpp"
#include "libtorrent/add_torrent_params.hpp"
#include "libtorrent/aux_/path.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>

// These MUST be non-blocking: completion arrives via lt_disk_complete_* on a later tick.
extern "C" {
  // file_list_json is a JSON array of {path, size} objects, hand-written by notify_js_new and JSON.parsed on the JS side
  void js_disk_new_storage(int storage_id, char const* save_path,
                           char const* file_list_json, int file_list_len);
  void js_disk_remove_storage(int storage_id);

  // The completion ptr must be allocated inside the WASM heap (the JS shim uses _malloc, we _free after copying).
  void js_disk_read(int storage_id, std::uint64_t job_id,
                    int file_index, std::int64_t offset, std::int32_t len);

  // JS reads the buffer inline before returning, so the caller can free / overwrite.
  void js_disk_write(int storage_id, std::uint64_t job_id,
                     int file_index, std::int64_t offset,
                     std::uint8_t const* data, std::int32_t len);

  void js_disk_release(int storage_id, std::uint64_t job_id);
  void js_disk_check(int storage_id, std::uint64_t job_id);
  void js_disk_move(int storage_id, std::uint64_t job_id, char const* new_path);
  void js_disk_delete(int storage_id, std::uint64_t job_id, std::uint32_t flags);
  void js_disk_rename(int storage_id, std::uint64_t job_id,
                      int file_index, char const* new_name);
  void js_disk_stop(int storage_id, std::uint64_t job_id);
}

#else
static inline void js_disk_new_storage(int, char const*, char const*, int) {}
static inline void js_disk_remove_storage(int) {}
static inline void js_disk_read(int, std::uint64_t, int, std::int64_t, std::int32_t) {}
static inline void js_disk_write(int, std::uint64_t, int, std::int64_t, std::uint8_t const*, std::int32_t) {}
static inline void js_disk_release(int, std::uint64_t) {}
static inline void js_disk_check(int, std::uint64_t) {}
static inline void js_disk_move(int, std::uint64_t, char const*) {}
static inline void js_disk_delete(int, std::uint64_t, std::uint32_t) {}
static inline void js_disk_rename(int, std::uint64_t, int, char const*) {}
static inline void js_disk_stop(int, std::uint64_t) {}
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace libtorrent {

namespace {

struct storage_entry {
  file_storage const* fs;
  std::string save_path;
  int num_files;
  // the key the wrapper joins a storage_index to its torrent_handle / handle-id by
  sha1_hash info_hash;
};

struct wasm_disk_io;
wasm_disk_io* g_disk_io = nullptr;

// Drained by the wrapper each pump to emit torrent-ready alert records.
std::vector<std::uint32_t> g_storage_ready_queue;

struct read_job {
  std::function<void(disk_buffer_holder, storage_error const&)> handler;
};

struct write_job {
  std::function<void(storage_error const&)> handler;
  std::shared_ptr<disk_observer> observer;
};

struct simple_job {
  std::function<void()> handler;
};

struct status_job {
  std::function<void(status_t, storage_error const&)> handler;
};

struct move_job {
  std::function<void(status_t, std::string const&, storage_error const&)> handler;
};

struct delete_job {
  std::function<void(storage_error const&)> handler;
};

struct rename_job {
  std::function<void(std::string const&, file_index_t, storage_error const&)> handler;
  file_index_t index;
};

struct prio_job {
  std::function<void(storage_error const&,
                     aux::vector<download_priority_t, file_index_t>)> handler;
  aux::vector<download_priority_t, file_index_t> prio;
};

using pending_job = std::variant<read_job, write_job, simple_job, status_job,
                                 move_job, delete_job, rename_job, prio_job>;

struct wasm_disk_io final
  : disk_interface
  , buffer_allocator_interface
{
  wasm_disk_io(io_context& ios, counters& cnt)
    : m_ios(ios), m_counters(cnt) {
    g_disk_io = this;
  }
  ~wasm_disk_io() override {
    g_disk_io = nullptr;
    g_storage_ready_queue.clear();
  }

  std::uint64_t next_job_id() { return ++m_job_seq; }

  storage_holder new_torrent(storage_params const& p,
                             std::shared_ptr<void> const&) override {
    storage_index_t const idx{static_cast<std::uint32_t>(m_storages.size())};
    storage_entry e;
    e.fs        = &p.files;
    e.save_path = p.path;
    e.num_files = p.files.num_files();
    e.info_hash = p.info_hash;
    m_storages.push_back(std::move(e));
    notify_js_new(static_cast<int>(idx));
    return storage_holder(idx, *this);
  }

  void remove_torrent(storage_index_t idx) override {
    // Drop the file_storage pointer - it aliases the torrent_info; query_storage's `!fs` guard then fails safe.
    auto const i = static_cast<std::size_t>(static_cast<int>(idx));
    if (i < m_storages.size()) m_storages[i].fs = nullptr;
    js_disk_remove_storage(static_cast<int>(idx));
    // We don't reclaim the slot - storage_index_t is sparse-tolerant.
  }

  void async_read(storage_index_t idx, peer_request const& r,
      std::function<void(disk_buffer_holder, storage_error const&)> handler,
      disk_job_flags_t) override
  {
    auto* se = storage_at(idx);
    if (!se) {
      post(m_ios, [handler] {
        handler(disk_buffer_holder{}, storage_error{
            error_code(boost::system::errc::invalid_argument, generic_category()),
            operation_t::partfile_read});
      });
      return;
    }
    auto slices = se->fs->map_block(r.piece, r.start, r.length);
    if (slices.empty()) {
      post(m_ios, [handler] {
        handler(disk_buffer_holder{}, storage_error{
            error_code(boost::system::errc::invalid_argument, generic_category()),
            operation_t::partfile_read});
      });
      return;
    }
    if (slices.size() == 1) {
      auto const& s = slices.front();
      if (se->fs->pad_file_at(s.file_index)) {
        auto const size = static_cast<std::int32_t>(s.size);
        auto* zeros = static_cast<std::uint8_t*>(std::calloc(std::max<std::size_t>(1, std::size_t(size)), 1));
        post(m_ios, [this, handler = std::move(handler), zeros, size] {
          handler(disk_buffer_holder(*this, reinterpret_cast<char*>(zeros), size), storage_error{});
        });
        return;
      }
      auto const job_id = next_job_id();
      {
        std::lock_guard<std::mutex> g(m_mu);
        m_pending.emplace(job_id, read_job{std::move(handler)});
      }
      js_disk_read(static_cast<int>(idx), job_id, static_cast<int>(s.file_index),
                   s.offset, static_cast<std::int32_t>(s.size));
      return;
    }
    auto* combined = static_cast<std::uint8_t*>(std::malloc(r.length));
    // pad slices never reach JS, so `remaining` counts only the reads that were actually issued
    int real_slices = 0;
    for (auto const& s : slices) if (!se->fs->pad_file_at(s.file_index)) ++real_slices;
    if (real_slices == 0) {
      std::memset(combined, 0, std::size_t(r.length));
      post(m_ios, [this, handler = std::move(handler), combined, len = r.length] {
        handler(disk_buffer_holder(*this, reinterpret_cast<char*>(combined), len), storage_error{});
      });
      return;
    }
    auto remaining = std::make_shared<std::atomic<int>>(real_slices);
    auto first_err = std::make_shared<std::atomic<int>>(0);
    /*
     * ONE handler, shared, never a copy per slice. This is a memory-safety requirement rather than
     * a saving, and `async_write` below has always done it this way.
     *
     * Capturing `handler` by value gives every sub-handler its own COPY of the caller's callable,
     * and the original is destroyed when this function returns. libtorrent's checking code hands
     * `async_hash` a span pointing INTO a vector that the callable owns (torrent.cpp: `hashes1 =
     * std::move(hashes)` beside `span<sha256_hash> v2_span(hashes)`), so copying the callable
     * duplicates the vector and frees the buffer the span still points at. The read then completes
     * and writes its v2 block hashes through that span, into freed memory.
     *
     * It was latent for four years because only a v2 or hybrid torrent passes a non-empty span, and
     * only a piece that STRADDLES a file boundary takes this multi-slice path. A hybrid pads every
     * file up to a piece boundary, so it straddles constantly and dies on the first such piece.
     * AddressSanitizer named it: heap-use-after-free, WRITE of size 32, on a 32-byte region
     * allocated by `vector<digest32<256>>::__append` inside `torrent::start_checking`.
     */
    auto shared_handler = std::make_shared<std::function<void(disk_buffer_holder, storage_error const&)>>(
        std::move(handler));
    std::int64_t byte_off = 0;
    for (auto const& s : slices) {
      if (se->fs->pad_file_at(s.file_index)) {
        std::memset(combined + byte_off, 0, std::size_t(s.size));
        byte_off += s.size;
        continue;
      }
      auto const sub_id = next_job_id();
      auto const this_off = byte_off;
      auto const this_size = static_cast<std::int32_t>(s.size);
      auto sub_handler = [this, combined, remaining, first_err, this_off, this_size,
                          total_len = r.length, shared_handler]
                         (disk_buffer_holder data, storage_error const& ec) mutable
      {
        if (ec && first_err->load() == 0) first_err->store(ec.ec.value());
        if (data) std::memcpy(combined + this_off, data.data(), this_size);
        if (remaining->fetch_sub(1, std::memory_order_acq_rel) != 1) return;
        int err = first_err->load();
        if (err != 0) {
          std::free(combined);
          (*shared_handler)(disk_buffer_holder{}, storage_error{
              error_code(err, system_category()), operation_t::file_read});
          return;
        }
        disk_buffer_holder holder(*this, reinterpret_cast<char*>(combined), total_len);
        (*shared_handler)(std::move(holder), storage_error{});
      };
      {
        std::lock_guard<std::mutex> g(m_mu);
        m_pending.emplace(sub_id, read_job{std::move(sub_handler)});
      }
      js_disk_read(static_cast<int>(idx), sub_id, static_cast<int>(s.file_index),
                   s.offset, this_size);
      byte_off += s.size;
    }
  }

  bool async_write(storage_index_t idx, peer_request const& r,
      char const* buf, std::shared_ptr<disk_observer> obs,
      std::function<void(storage_error const&)> handler,
      disk_job_flags_t) override
  {
    auto* se = storage_at(idx);
    if (!se) {
      post(m_ios, [handler] {
        handler(storage_error{
            error_code(boost::system::errc::invalid_argument, generic_category()),
            operation_t::file_write});
      });
      return false;
    }
    auto slices = se->fs->map_block(r.piece, r.start, r.length);
    if (slices.empty()) {
      post(m_ios, [handler] {
        handler(storage_error{
            error_code(boost::system::errc::invalid_argument, generic_category()),
            operation_t::file_write});
      });
      return false;
    }
    if (slices.size() == 1) {
      auto const& s = slices.front();
      // a write to a pad file is a no-op: those bytes are zeroes by definition and are stored nowhere
      if (se->fs->pad_file_at(s.file_index)) {
        post(m_ios, [handler = std::move(handler)] { handler(storage_error{}); });
        return false;
      }
      auto const job_id = next_job_id();
      {
        std::lock_guard<std::mutex> g(m_mu);
        m_pending.emplace(job_id, write_job{std::move(handler), std::move(obs)});
      }
      js_disk_write(static_cast<int>(idx), job_id, static_cast<int>(s.file_index),
                    s.offset, reinterpret_cast<std::uint8_t const*>(buf),
                    static_cast<std::int32_t>(s.size));
      return false;
    }
    int real_slices = 0;
    for (auto const& s : slices) if (!se->fs->pad_file_at(s.file_index)) ++real_slices;
    if (real_slices == 0) {
      post(m_ios, [handler = std::move(handler)] { handler(storage_error{}); });
      return false;
    }
    auto remaining = std::make_shared<std::atomic<int>>(real_slices);
    auto first_err = std::make_shared<std::atomic<int>>(0);
    auto shared_obs = std::shared_ptr<disk_observer>(std::move(obs));
    auto shared_handler = std::make_shared<std::function<void(storage_error const&)>>(std::move(handler));
    std::int64_t byte_off = 0;
    for (auto const& s : slices) {
      if (se->fs->pad_file_at(s.file_index)) { byte_off += s.size; continue; }
      auto const sub_id = next_job_id();
      auto const this_off = byte_off;
      auto sub_handler = [remaining, first_err, shared_handler]
                         (storage_error const& ec) {
        if (ec && first_err->load() == 0) first_err->store(ec.ec.value());
        if (remaining->fetch_sub(1, std::memory_order_acq_rel) != 1) return;
        int err = first_err->load();
        (*shared_handler)(err != 0
          ? storage_error{error_code(err, system_category()), operation_t::file_write}
          : storage_error{});
      };
      {
        std::lock_guard<std::mutex> g(m_mu);
        m_pending.emplace(sub_id, write_job{std::move(sub_handler), shared_obs});
      }
      js_disk_write(static_cast<int>(idx), sub_id, static_cast<int>(s.file_index),
                    s.offset,
                    reinterpret_cast<std::uint8_t const*>(buf) + this_off,
                    static_cast<std::int32_t>(s.size));
      byte_off += s.size;
    }
    return false;
  }

  void async_hash(storage_index_t idx, piece_index_t piece,
      span<sha256_hash> v2, disk_job_flags_t flags,
      std::function<void(piece_index_t, sha1_hash const&, storage_error const&)> handler) override
  {
    auto* se = storage_at(idx);
    if (!se) {
      post(m_ios, [handler, piece] {
        handler(piece, sha1_hash{}, storage_error{
            error_code(boost::system::errc::invalid_argument, generic_category()),
            operation_t::partfile_read});
      });
      return;
    }
    /*
     * THE V1 AND V2 PIECE SIZES ARE NOT THE SAME NUMBER, and this used to use the v1 one for both.
     *
     * `piece_size` is the whole piece, pad bytes included. `piece_size2` is the piece CLAMPED to the
     * end of the file it belongs to, which is what a v2 leaf covers: a v2 hash is over one file's
     * bytes and stops where the file stops. Hashing the padded length instead absorbs the pad
     * zeroes into the last leaf of every file that does not end on a 16 KiB boundary, and produces
     * one leaf too many.
     *
     * The result is a torrent whose v1 half verifies and whose v2 half does not, which libtorrent
     * routes to `handle_inconsistent_hashes`: the whole have-set is dropped and the torrent pauses
     * with `torrent_inconsistent_hashes`. Since a pad follows nearly every file, that is nearly
     * every v2 or hybrid torrent, on the first piece that ends a file.
     *
     * Sizes follow mmap_disk_io::do_hash, which is the reference implementation.
     */
    bool const want_v1 = bool(flags & disk_interface::v1_hash);
    bool const want_v2 = !v2.empty();
    int const piece_size = se->fs->piece_size(piece);
    int const piece_size2 = want_v2 ? se->fs->piece_size2(piece) : 0;
    // piece_size2 never exceeds piece_size, so the v1 read covers the v2 blocks as a prefix
    int const read_size = want_v1 ? piece_size : piece_size2;
    if (read_size <= 0) {
      post(m_ios, [handler = std::move(handler), piece] { handler(piece, sha1_hash{}, storage_error{}); });
      return;
    }
    auto buf = std::make_shared<std::vector<char>>(read_size);
    peer_request r;
    r.piece = piece;
    r.start = 0;
    r.length = read_size;
    int const blocks2 = want_v2 ? se->fs->blocks_in_piece2(piece) : 0;
    async_read(idx, r,
      [this, piece, buf, handler = std::move(handler), v2, want_v1, want_v2, piece_size, piece_size2, blocks2]
      (disk_buffer_holder holder, storage_error const& ec) mutable {
        if (ec) {
          handler(piece, sha1_hash{}, ec);
          return;
        }
        std::memcpy(buf->data(), holder.data(), buf->size());

        sha1_hash sha1;
        if (want_v1) {
          hasher h;
          h.update({buf->data(), static_cast<std::ptrdiff_t>(piece_size)});
          sha1 = h.final();
        }

        if (want_v2) {
          constexpr int block = default_block_size;
          for (int b = 0; b < blocks2 && b < static_cast<int>(v2.size()); ++b) {
            int const off = b * block;
            // the LAST leaf of a file is hashed short, never zero filled out to a whole block
            int const sz = std::min<int>(block, piece_size2 - off);
            if (sz <= 0) break;
            hasher256 h2;
            h2.update({buf->data() + off, sz});
            v2[b] = h2.final();
          }
        }
        handler(piece, sha1, storage_error{});
      }, {});
  }

  void async_hash2(storage_index_t idx, piece_index_t piece, int offset,
      disk_job_flags_t,
      std::function<void(piece_index_t, sha256_hash const&, storage_error const&)> handler) override
  {
    auto* se = storage_at(idx);
    if (!se) {
      post(m_ios, [handler, piece] {
        handler(piece, sha256_hash{}, storage_error{
            error_code(boost::system::errc::invalid_argument, generic_category()),
            operation_t::partfile_read});
      });
      return;
    }
    // piece_size2, not piece_size: a v2 block stops at the end of its file. See async_hash above.
    int const piece_size = se->fs->piece_size2(piece);
    int const sz = std::min<int>(default_block_size, piece_size - offset);
    if (sz <= 0) {
      post(m_ios, [handler = std::move(handler), piece] { handler(piece, sha256_hash{}, storage_error{}); });
      return;
    }
    auto buf = std::make_shared<std::vector<char>>(sz);
    peer_request r;
    r.piece = piece;
    r.start = offset;
    r.length = sz;
    async_read(idx, r,
      [piece, buf, handler = std::move(handler)]
      (disk_buffer_holder holder, storage_error const& ec) {
        if (ec) {
          handler(piece, sha256_hash{}, ec);
          return;
        }
        hasher256 h;
        h.update({holder.data(), static_cast<std::ptrdiff_t>(holder.size())});
        handler(piece, h.final(), storage_error{});
      }, {});
  }

  void async_move_storage(storage_index_t idx, std::string p, move_flags_t,
      std::function<void(status_t, std::string const&, storage_error const&)> handler) override
  {
    auto job_id = next_job_id();
    {
      std::lock_guard<std::mutex> g(m_mu);
      m_pending.emplace(job_id, move_job{std::move(handler)});
    }
    js_disk_move(static_cast<int>(idx), job_id, p.c_str());
  }

  void async_release_files(storage_index_t idx,
      std::function<void()> handler) override
  {
    auto job_id = next_job_id();
    {
      std::lock_guard<std::mutex> g(m_mu);
      m_pending.emplace(job_id, simple_job{std::move(handler)});
    }
    js_disk_release(static_cast<int>(idx), job_id);
  }

  void async_check_files(storage_index_t idx,
      add_torrent_params const* /*resume*/,
      aux::vector<std::string, file_index_t> /*links*/,
      std::function<void(status_t, storage_error const&)> handler) override
  {
    auto job_id = next_job_id();
    {
      std::lock_guard<std::mutex> g(m_mu);
      m_pending.emplace(job_id, status_job{std::move(handler)});
    }
    js_disk_check(static_cast<int>(idx), job_id);
  }

  void async_stop_torrent(storage_index_t idx,
      std::function<void()> handler) override
  {
    auto job_id = next_job_id();
    {
      std::lock_guard<std::mutex> g(m_mu);
      m_pending.emplace(job_id, simple_job{std::move(handler)});
    }
    js_disk_stop(static_cast<int>(idx), job_id);
  }

  void async_rename_file(storage_index_t idx, file_index_t index,
      std::string name,
      std::function<void(std::string const&, file_index_t, storage_error const&)> handler) override
  {
    auto job_id = next_job_id();
    {
      std::lock_guard<std::mutex> g(m_mu);
      m_pending.emplace(job_id, rename_job{std::move(handler), index});
    }
    js_disk_rename(static_cast<int>(idx), job_id,
                   static_cast<int>(index), name.c_str());
  }

  void async_delete_files(storage_index_t idx, remove_flags_t options,
      std::function<void(storage_error const&)> handler) override
  {
    auto job_id = next_job_id();
    {
      std::lock_guard<std::mutex> g(m_mu);
      m_pending.emplace(job_id, delete_job{std::move(handler)});
    }
    js_disk_delete(static_cast<int>(idx), job_id,
                   static_cast<std::uint32_t>(options));
  }

  void async_set_file_priority(storage_index_t /*idx*/,
      aux::vector<download_priority_t, file_index_t> prio,
      std::function<void(storage_error const&,
          aux::vector<download_priority_t, file_index_t>)> handler) override
  {
    // No real filesystem reshuffle in browser-land - just echo back.
    post(m_ios, [h = std::move(handler), p = std::move(prio)] () mutable {
      h(storage_error{}, std::move(p));
    });
  }

  void async_clear_piece(storage_index_t,
      piece_index_t index,
      std::function<void(piece_index_t)> handler) override
  {
    post(m_ios, [h = std::move(handler), index] { h(index); });
  }

  void complete_read(std::uint64_t job_id, std::uint8_t* data, std::int32_t len,
                     std::int32_t err) {
    pending_job pj;
    {
      std::lock_guard<std::mutex> g(m_mu);
      auto it = m_pending.find(job_id);
      if (it == m_pending.end()) return;
      pj = std::move(it->second);
      m_pending.erase(it);
    }
    auto* job = std::get_if<read_job>(&pj);
    if (!job) return;
    auto handler = std::move(job->handler);
    post(m_ios, [this, handler = std::move(handler), data, len, err] {
      if (err) {
        handler(disk_buffer_holder{}, storage_error{
            error_code(err, system_category()),
            operation_t::file_read});
      } else {
        handler(disk_buffer_holder(*this, reinterpret_cast<char*>(data), len),
                storage_error{});
      }
    });
  }

  void complete_write(std::uint64_t job_id, std::int32_t err) {
    pending_job pj;
    {
      std::lock_guard<std::mutex> g(m_mu);
      auto it = m_pending.find(job_id);
      if (it == m_pending.end()) return;
      pj = std::move(it->second);
      m_pending.erase(it);
    }
    auto* job = std::get_if<write_job>(&pj);
    if (!job) return;
    post(m_ios, [handler = std::move(job->handler), err] {
      handler(err
        ? storage_error{error_code(err, system_category()), operation_t::file_write}
        : storage_error{});
    });
  }

  void complete_simple(std::uint64_t job_id) {
    pending_job pj;
    {
      std::lock_guard<std::mutex> g(m_mu);
      auto it = m_pending.find(job_id);
      if (it == m_pending.end()) return;
      pj = std::move(it->second);
      m_pending.erase(it);
    }
    if (auto* j = std::get_if<simple_job>(&pj)) {
      post(m_ios, [h = std::move(j->handler)] { h(); });
    }
  }

  void complete_status(std::uint64_t job_id, std::int32_t status_code,
                       std::int32_t err) {
    pending_job pj;
    {
      std::lock_guard<std::mutex> g(m_mu);
      auto it = m_pending.find(job_id);
      if (it == m_pending.end()) return;
      pj = std::move(it->second);
      m_pending.erase(it);
    }
    if (auto* j = std::get_if<status_job>(&pj)) {
      post(m_ios, [h = std::move(j->handler), status_code, err] {
        h(static_cast<status_t>(status_code),
          err ? storage_error{error_code(err, system_category()),
                              operation_t::file} : storage_error{});
      });
    }
  }

  void complete_move(std::uint64_t job_id, char const* new_path,
                     std::int32_t status_code, std::int32_t err) {
    pending_job pj;
    {
      std::lock_guard<std::mutex> g(m_mu);
      auto it = m_pending.find(job_id);
      if (it == m_pending.end()) return;
      pj = std::move(it->second);
      m_pending.erase(it);
    }
    if (auto* j = std::get_if<move_job>(&pj)) {
      std::string p = new_path ? new_path : "";
      post(m_ios, [h = std::move(j->handler), p = std::move(p), status_code, err] () mutable {
        h(static_cast<status_t>(status_code), p,
          err ? storage_error{error_code(err, system_category()),
                              operation_t::file_rename} : storage_error{});
      });
    }
  }

  void complete_delete(std::uint64_t job_id, std::int32_t err) {
    pending_job pj;
    {
      std::lock_guard<std::mutex> g(m_mu);
      auto it = m_pending.find(job_id);
      if (it == m_pending.end()) return;
      pj = std::move(it->second);
      m_pending.erase(it);
    }
    if (auto* j = std::get_if<delete_job>(&pj)) {
      post(m_ios, [h = std::move(j->handler), err] {
        h(err
          ? storage_error{error_code(err, system_category()), operation_t::file_remove}
          : storage_error{});
      });
    }
  }

  void complete_rename(std::uint64_t job_id, char const* new_name,
                       std::int32_t err) {
    pending_job pj;
    {
      std::lock_guard<std::mutex> g(m_mu);
      auto it = m_pending.find(job_id);
      if (it == m_pending.end()) return;
      pj = std::move(it->second);
      m_pending.erase(it);
    }
    if (auto* j = std::get_if<rename_job>(&pj)) {
      std::string n = new_name ? new_name : "";
      auto idx = j->index;
      post(m_ios, [h = std::move(j->handler), n = std::move(n), idx, err] () mutable {
        h(n, idx, err
          ? storage_error{error_code(err, system_category()), operation_t::file_rename}
          : storage_error{});
      });
    }
  }

  // must stay a plain std::free: read buffers come from JS via _malloc (and the multi-slice combined buffer from std::malloc), so a pool or another allocator corrupts the WASM heap
  void free_disk_buffer(char* buf) override {
    std::free(buf);
  }

  void update_stats_counters(counters& c) const override {
    c.set_value(counters::disk_blocks_in_use,
                static_cast<int>(m_pending.size()));
  }

  std::vector<open_file_state> get_status(storage_index_t) const override {
    return {};
  }

  void abort(bool) override {
    std::lock_guard<std::mutex> g(m_mu);
    m_pending.clear();
  }

  void settings_updated() override {}
  void submit_jobs() override {}

  bool query_storage(std::uint32_t idx, wasm_storage_info& out) const {
    auto* se = storage_at(storage_index_t{idx});
    if (!se || !se->fs) return false;
    out.info_hash = se->info_hash;
    out.fs        = se->fs;
    out.save_path = se->save_path.c_str();
    return true;
  }

private:
  storage_entry const* storage_at(storage_index_t idx) const {
    auto i = static_cast<std::size_t>(static_cast<int>(idx));
    return i < m_storages.size() ? &m_storages[i] : nullptr;
  }

  void map_piece(storage_index_t idx, piece_index_t piece, int start_offset,
                 int& file_index, std::int64_t& file_offset) const {
    auto* se = storage_at(idx);
    if (!se) { file_index = -1; file_offset = 0; return; }
    auto slices = se->fs->map_block(piece, start_offset, 1);
    if (slices.empty()) { file_index = -1; file_offset = 0; return; }
    file_index  = static_cast<int>(slices.front().file_index);
    file_offset = slices.front().offset;
  }

  void notify_js_new(int storage_id) {
    auto const& se = m_storages[storage_id];
    std::string json = "[";
    for (file_index_t i{0}; i < file_index_t{se.num_files}; ++i) {
      if (static_cast<int>(i) > 0) json += ',';
      auto name = se.fs->file_path(i);
      json += "{\"path\":\"";
      for (char c : name) {
        if (c == '"' || c == '\\') json += '\\';
        json += c;
      }
      json += "\",\"size\":";
      json += std::to_string(se.fs->file_size(i));
      json += "}";
    }
    json += "]";
    js_disk_new_storage(storage_id, se.save_path.c_str(),
                        json.c_str(), static_cast<int>(json.size()));
    g_storage_ready_queue.push_back(static_cast<std::uint32_t>(storage_id));
  }

  io_context& m_ios;
  counters& m_counters;
  std::vector<storage_entry> m_storages;

  mutable std::mutex m_mu;
  std::unordered_map<std::uint64_t, pending_job> m_pending;
  std::atomic<std::uint64_t> m_job_seq{0};
};

} // namespace

int wasm_disk_take_ready(std::uint32_t* out, int max) {
  int n = 0;
  while (n < max && !g_storage_ready_queue.empty()) {
    out[n++] = g_storage_ready_queue.front();
    g_storage_ready_queue.erase(g_storage_ready_queue.begin());
  }
  return n;
}

void wasm_disk_requeue_ready(std::uint32_t storage_index) {
  g_storage_ready_queue.push_back(storage_index);
}

int wasm_disk_storage_info(std::uint32_t storage_index, wasm_storage_info* out) {
  if (!g_disk_io || !out) return -1;
  return g_disk_io->query_storage(storage_index, *out) ? 0 : -1;
}

std::unique_ptr<disk_interface> wasm_disk_io_constructor(
    io_context& ios, settings_interface const&, counters& cnt) {
  return std::make_unique<wasm_disk_io>(ios, cnt);
}

} // namespace libtorrent

extern "C" EMSCRIPTEN_KEEPALIVE
void lt_disk_complete_read(std::uint64_t job_id, std::uint8_t* data,
                           std::int32_t len, std::int32_t err) {
  if (auto* io = libtorrent::g_disk_io) io->complete_read(job_id, data, len, err);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void lt_disk_complete_write(std::uint64_t job_id, std::int32_t err) {
  if (auto* io = libtorrent::g_disk_io) io->complete_write(job_id, err);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void lt_disk_complete_simple(std::uint64_t job_id) {
  if (auto* io = libtorrent::g_disk_io) io->complete_simple(job_id);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void lt_disk_complete_status(std::uint64_t job_id, std::int32_t status_code,
                             std::int32_t err) {
  if (auto* io = libtorrent::g_disk_io) io->complete_status(job_id, status_code, err);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void lt_disk_complete_move(std::uint64_t job_id, char const* new_path,
                           std::int32_t status_code, std::int32_t err) {
  if (auto* io = libtorrent::g_disk_io) io->complete_move(job_id, new_path, status_code, err);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void lt_disk_complete_delete(std::uint64_t job_id, std::int32_t err) {
  if (auto* io = libtorrent::g_disk_io) io->complete_delete(job_id, err);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void lt_disk_complete_rename(std::uint64_t job_id, char const* new_name,
                             std::int32_t err) {
  if (auto* io = libtorrent::g_disk_io) io->complete_rename(job_id, new_name, err);
}
