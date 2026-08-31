// every C call here is non-blocking: JS drives io_context.poll() via lt_session_tick(), no Asyncify

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include <unordered_map>

#ifdef __EMSCRIPTEN__
// strong override for emscripten's weak stub, which returns -ENOPROTOOPT and makes Asio refuse to write
extern "C" int __syscall_setsockopt(int /*fd*/, int /*level*/, int /*optname*/,
                                    int /*optval*/, int /*optlen*/, int /*dummy*/) {
  return 0;
}
#endif

#include "libtorrent/session.hpp"
#include "libtorrent/session_params.hpp"
#include "libtorrent/settings_pack.hpp"
#include "libtorrent/torrent_handle.hpp"
#include "libtorrent/add_torrent_params.hpp"
#include "libtorrent/magnet_uri.hpp"
#include "libtorrent/alert_types.hpp"
#include "libtorrent/alert.hpp"
#include "libtorrent/torrent_status.hpp"
#include "libtorrent/torrent_info.hpp"
#include "libtorrent/error_code.hpp"
#include "libtorrent/sha1_hash.hpp"
#include "libtorrent/hex.hpp"
#include "libtorrent/info_hash.hpp"
#include "libtorrent/file_storage.hpp"
#include "libtorrent/torrent_flags.hpp"
#include "libtorrent/download_priority.hpp"
#include "libtorrent/write_resume_data.hpp"
#include "libtorrent/read_resume_data.hpp"
#include "libtorrent/session_handle.hpp"
#include "libtorrent/torrent.hpp"
// torrent.hpp only forward-declares peer_connection, and lt_torrent_cancel_piece_requests reaches
// into each peer's download and request queues, so the definition has to come in explicitly
#include "libtorrent/peer_connection.hpp"
#include "libtorrent/piece_block.hpp"
#include "libtorrent/piece_picker.hpp"
#include "libtorrent/aux_/utp_stream.hpp"
#include <boost/asio/post.hpp>

#include "disk_io.hpp"

static bool g_log_enabled = false;

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define LT_API extern "C" EMSCRIPTEN_KEEPALIVE
#define LT_LOG(msg) do { if (g_log_enabled) emscripten_log(EM_LOG_CONSOLE, "%s", msg); } while (0)
#else
#define LT_API extern "C"
#define LT_LOG(msg) ((void)0)
#endif

LT_API void lt_set_log(int on) { g_log_enabled = on != 0; }

namespace {

struct torrent_geometry {
  std::int32_t num_pieces = 0;
  std::int32_t num_files = 0;
};

struct session_state {
  std::unique_ptr<lt::io_context> ioc;
  std::unique_ptr<lt::session> ses;

  std::unordered_map<std::uint32_t, lt::torrent_handle> handles;
  std::unordered_map<std::string, std::uint32_t> hash_ids;
  // piece and file counts, cached when the torrent-ready record is built. Every synchronous
  // libtorrent getter (torrent_file(), get_piece_priorities()) sync_calls an io_context that only
  // runs when JS ticks, so it would deadlock here: a bounds check has to read this, never the handle.
  std::unordered_map<std::uint32_t, torrent_geometry> geometry;
  std::uint32_t next_handle_id = 1;
};

session_state* g_session = nullptr;

// wire format JS drains, per record: u32 type (alert::type()), u32 payload size, payload bytes
struct alert_buffer {
  std::vector<std::uint8_t> data;
  void put_u32(std::uint32_t v) {
    auto p = reinterpret_cast<std::uint8_t const*>(&v);
    data.insert(data.end(), p, p + 4);
  }
  void put_bytes(void const* src, std::size_t n) {
    auto p = static_cast<std::uint8_t const*>(src);
    data.insert(data.end(), p, p + n);
  }
};

alert_buffer g_pending_alerts;

// stable id for an info-hash: add_* and the later add_torrent_alert MUST resolve to the same id
std::uint32_t id_for_hash(lt::sha1_hash const& key) {
  if (!g_session) return 0;
  auto const k = key.to_string();
  auto it = g_session->hash_ids.find(k);
  if (it != g_session->hash_ids.end()) return it->second;
  auto id = g_session->next_handle_id++;
  g_session->hash_ids.emplace(k, id);
  return id;
}

std::uint32_t register_handle(lt::torrent_handle h) {
  if (!h.is_valid()) return 0;
  auto const id = id_for_hash(h.info_hashes().get_best());
  g_session->handles[id] = std::move(h);
  return id;
}

lt::torrent_handle* lookup_handle(std::uint32_t id) {
  auto it = g_session->handles.find(id);
  return it == g_session->handles.end() ? nullptr : &it->second;
}

// null until the torrent-ready record has been built for this handle
torrent_geometry const* geometry_for(std::uint32_t id) {
  auto it = g_session->geometry.find(id);
  return it == g_session->geometry.end() ? nullptr : &it->second;
}

// record ids avoid real libtorrent alert ids (5/41/45/67/68) and the 0xFFFFFFFx diagnostic sentinels; all ints little-endian
constexpr std::uint32_t REC_TORRENT_READY = 0xF0000001u;
constexpr std::uint32_t REC_STATE_UPDATE  = 0xF0000002u;
constexpr std::uint32_t REC_READ_PIECE    = 0xF0000003u;
constexpr std::uint32_t REC_RESUME_DATA   = 0xF0000004u;
constexpr std::uint32_t REC_PEERS         = 0xF0000005u;
constexpr std::uint32_t REC_TRACKERS      = 0xF0000006u;

// info_hashes()/get_best() read m_torrent directly, so unlike the other getters this does not sync_call
std::uint32_t handle_id_for_hash(lt::sha1_hash const& key) {
  if (!g_session) return 0;
  for (auto const& [id, h] : g_session->handles)
    if (h.is_valid() && h.info_hashes().get_best() == key) return id;
  return 0;
}

void put_record(std::uint32_t type, std::vector<std::uint8_t> const& payload) {
  g_pending_alerts.put_u32(type);
  g_pending_alerts.put_u32(static_cast<std::uint32_t>(payload.size()));
  g_pending_alerts.put_bytes(payload.data(), payload.size());
}

// returns false ONLY when the handle isn't registered yet (caller re-queues); true also covers undeliverable, which must NOT be retried
bool emit_torrent_ready(std::uint32_t storage_index) {
  lt::wasm_storage_info si{};
  if (lt::wasm_disk_storage_info(storage_index, &si) != 0) return true;
  if (!si.fs || !si.fs->is_valid()) return true;
  std::uint32_t const hid = handle_id_for_hash(si.info_hash);
  if (hid == 0) return false;
  auto const* fs = si.fs;
  int const nf = fs->num_files();
  g_session->geometry[hid] = torrent_geometry{fs->num_pieces(), nf};
  std::vector<std::uint8_t> p;
  auto u32 = [&](std::uint32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
  auto i64 = [&](std::int64_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 8); };
  u32(hid);
  u32(storage_index);
  u32(static_cast<std::uint32_t>(fs->piece_length()));
  u32(static_cast<std::uint32_t>(fs->num_pieces()));
  i64(fs->total_size());
  u32(static_cast<std::uint32_t>(nf));
  for (lt::file_index_t i{0}; i < lt::file_index_t{nf}; ++i) {
    i64(fs->file_offset(i));
    i64(fs->file_size(i));
    /*
     * IS THIS A PAD FILE, which is a thing only the engine can answer.
     *
     * A v2 or hybrid torrent carries zero-filled pad files that push each real file onto a piece
     * boundary. They occupy an INDEX like any other file, so they cannot be filtered out of this
     * list without shifting every index after them and serving one file's bytes for another. The
     * caller needs them present and needs to know which they are: a pad is not the person's data,
     * so it belongs in no file list, no size total, no mirror to their folder and no zip.
     *
     * Sent as a flag rather than left to the caller to infer from the `.pad/<size>` path libtorrent
     * happens to write, because `pad_file_at` is the actual answer and a name is a guess.
     */
    p.push_back(fs->pad_file_at(i) ? 1 : 0);
    std::string const path = fs->file_path(i);
    u32(static_cast<std::uint32_t>(path.size()));
    p.insert(p.end(), path.begin(), path.end());
  }
  put_record(REC_TORRENT_READY, p);
  return true;
}

void emit_state_update(lt::state_update_alert const* sua) {
  for (auto const& st : sua->status) {
    std::uint32_t const hid = handle_id_for_hash(st.info_hashes.get_best());
    if (hid == 0) continue;
    int const nbits = st.pieces.size();
    int const nbytes = (nbits + 7) / 8;
    std::vector<std::uint8_t> p;
    auto u32 = [&](std::uint32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
    auto i32 = [&](std::int32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
    auto i64 = [&](std::int64_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 8); };
    auto f32 = [&](float v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
    u32(hid);
    i32(static_cast<std::int32_t>(st.state));
    i64(st.total_done);
    i64(st.total_wanted);
    f32(st.progress);
    i32(st.download_payload_rate);
    i32(st.upload_payload_rate);
    i32(st.num_peers);
    i32(st.num_seeds);
    u32((st.flags & lt::torrent_flags::paused) ? 1u : 0u);
    // auto_managed survives an error, so errc set is a failure while auto-managed without an error is the queue
    u32((st.flags & lt::torrent_flags::auto_managed) ? 1u : 0u);
    // so a streaming caller can confirm set_sequential landed rather than assuming it
    u32((st.flags & lt::torrent_flags::sequential_download) ? 1u : 0u);
    // The whole flag word, so a UI drawing a checkbox per flag reads the torrent's real state
    // rather than remembering what it last asked for. The three booleans above are kept because
    // they already have consumers; they are decoded from this same value in the same statement, so
    // they cannot disagree with it.
    u32(static_cast<std::uint32_t>(static_cast<std::uint64_t>(st.flags) & 0xFFFFFFFFull));

    /**
     * The accounting a torrent client puts on its details pane.
     *
     * `all_time_*` are the ones that answer "how much have I moved for this torrent", across every
     * session, and they survive a restart only because they ride the resume data. `total_*` are
     * this session alone, which is why both are sent: a ratio computed from the session figures is
     * wrong for anything that has ever been restarted.
     *
     * `num_complete` and `num_incomplete` are the SWARM's counts from the tracker, as distinct from
     * `num_seeds`/`num_peers` above, which are what we are connected to. Both are -1 until a
     * tracker has answered, and -1 has to reach JS intact rather than being clamped to 0.
     */
    i64(st.all_time_download);
    i64(st.all_time_upload);
    i64(st.total_download);
    i64(st.total_upload);
    i64(st.total_payload_download);
    i64(st.total_payload_upload);
    // hash failures plus bytes that arrived after we already had them: "wasted" in every client
    i64(st.total_failed_bytes + st.total_redundant_bytes);
    i32(st.num_complete);
    i32(st.num_incomplete);
    i32(st.num_connections);
    i32(st.connections_limit);
    i32(st.num_pieces);
    // fractional availability: how many complete copies the connected swarm adds up to
    f32(st.distributed_copies);
    // seconds, as libtorrent counts them: active includes seeding, seeding is the tail after finishing
    i32(static_cast<std::int32_t>(st.active_duration.count()));
    i32(static_cast<std::int32_t>(st.seeding_duration.count()));
    // unix seconds, 0 when it has not happened
    i64(static_cast<std::int64_t>(st.added_time));
    i64(static_cast<std::int64_t>(st.completed_time));
    i64(static_cast<std::int64_t>(st.last_seen_complete));
    u32(st.has_incoming ? 1u : 0u);
    {
      std::string const sp = st.save_path;
      u32(static_cast<std::uint32_t>(sp.size()));
      p.insert(p.end(), sp.begin(), sp.end());
    }
    i32(static_cast<std::int32_t>(static_cast<int>(st.queue_position)));
    i32(st.errc ? st.errc.value() : 0);
    std::string const err = st.errc ? st.errc.message() : std::string();
    u32(static_cast<std::uint32_t>(err.size()));
    p.insert(p.end(), err.begin(), err.end());
    u32(static_cast<std::uint32_t>(nbits));
    u32(static_cast<std::uint32_t>(nbytes));
    std::size_t const base = p.size();
    p.resize(base + static_cast<std::size_t>(nbytes), 0);
    // MSB-first within each byte (bit 0 → 0x80 of byte 0) to match webtorrent + ripple's downloaded-ranges.ts
    for (int i = 0; i < nbits; ++i)
      if (st.pieces.get_bit(i)) p[base + static_cast<std::size_t>(i / 8)] |= static_cast<std::uint8_t>(0x80u >> (i & 7));
    put_record(REC_STATE_UPDATE, p);
  }
}

void emit_read_piece(lt::read_piece_alert const* rpa) {
  if (rpa->error) return;
  std::uint32_t const hid = handle_id_for_hash(rpa->handle.info_hashes().get_best());
  if (hid == 0) return;
  std::vector<std::uint8_t> p;
  auto u32 = [&](std::uint32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
  u32(hid);
  u32(static_cast<std::uint32_t>(static_cast<int>(rpa->piece)));
  u32(static_cast<std::uint32_t>(rpa->size));
  p.insert(p.end(), rpa->buffer.get(), rpa->buffer.get() + rpa->size);
  put_record(REC_READ_PIECE, p);
}

void emit_resume_data(lt::save_resume_data_alert const* a) {
  std::uint32_t const hid = handle_id_for_hash(a->params.info_hashes.get_best());
  if (hid == 0) return;
  std::vector<char> const buf = lt::write_resume_data_buf(a->params);
  std::vector<std::uint8_t> p;
  auto u32 = [&](std::uint32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
  u32(hid);
  p.insert(p.end(), buf.begin(), buf.end());
  put_record(REC_RESUME_DATA, p);
}

// endpoint as one length-prefixed string, so v4 and v6 need no separate encoding on the JS side
std::string endpoint_string(lt::tcp::endpoint const& ep) {
  // the error_code overload is deprecated and gone in this boost; this one throws only on a
  // scope-id formatting failure, which cannot happen for an endpoint asio itself produced
  std::string const addr = ep.address().to_string();
  return (ep.address().is_v6() ? "[" + addr + "]:" : addr + ":") + std::to_string(ep.port());
}

/**
 * The connected peers, as the panel that shows them needs them.
 *
 * peer_info carries about sixty fields and almost all of them are for tuning libtorrent rather than
 * for telling a person what is going on, so this takes the ones a torrent client actually puts on
 * screen: who, over what, how fast, how much, and how much of the torrent they have.
 *
 * `flags` and `source` ship as raw bit fields rather than as decoded booleans. They are libtorrent's
 * own stable constants, JS names them from the same numbers, and adding a flag later then costs
 * nothing on this side.
 */
void emit_peers(lt::peer_info_alert const* a) {
  std::uint32_t const hid = handle_id_for_hash(a->handle.info_hashes().get_best());
  if (hid == 0) return;
  std::vector<std::uint8_t> p;
  auto u32 = [&](std::uint32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
  auto i32 = [&](std::int32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
  auto i64 = [&](std::int64_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 8); };
  auto str = [&](std::string const& s) {
    u32(static_cast<std::uint32_t>(s.size()));
    p.insert(p.end(), s.begin(), s.end());
  };
  u32(hid);
  u32(static_cast<std::uint32_t>(a->peer_info.size()));
  for (auto const& pi : a->peer_info) {
    str(endpoint_string(pi.ip));
    // already UTF-8 per peer_info.hpp:84, and arbitrary: it is whatever the remote client called itself
    str(pi.client);
    u32(static_cast<std::uint32_t>(pi.flags));
    u32(static_cast<std::uint32_t>(pi.source));
    u32(static_cast<std::uint32_t>(pi.connection_type));
    i32(pi.down_speed);
    i32(pi.up_speed);
    i32(pi.payload_down_speed);
    i32(pi.payload_up_speed);
    i64(pi.total_download);
    i64(pi.total_upload);
    // parts per million, not the float next to it: an integer crosses the boundary exactly
    i32(pi.progress_ppm);
    i32(pi.rtt);
    i32(pi.num_pieces);
    i32(pi.download_queue_length);
    i32(pi.failcount);
  }
  put_record(REC_PEERS, p);
}

/**
 * The trackers, flattened from libtorrent's two-level shape.
 *
 * An announce_entry holds one URL and then a list of endpoints under it, one per local interface,
 * and each endpoint holds its state per info-hash protocol (v1 and v2 announce separately). A user
 * looking at a tracker list wants one row per tracker, so this collapses that: the row carries the
 * URL and tier, and the status reported is the healthiest endpoint's, since a tracker reachable
 * over any interface is a tracker that works.
 */
void emit_trackers(lt::tracker_list_alert const* a) {
  std::uint32_t const hid = handle_id_for_hash(a->handle.info_hashes().get_best());
  if (hid == 0) return;
  std::vector<std::uint8_t> p;
  auto u32 = [&](std::uint32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
  auto i32 = [&](std::int32_t v){ auto* b = reinterpret_cast<std::uint8_t*>(&v); p.insert(p.end(), b, b + 4); };
  auto str = [&](std::string const& s) {
    u32(static_cast<std::uint32_t>(s.size()));
    p.insert(p.end(), s.begin(), s.end());
  };
  u32(hid);
  u32(static_cast<std::uint32_t>(a->trackers.size()));
  auto const now = lt::clock_type::now();
  for (auto const& t : a->trackers) {
    // Best across every endpoint and both protocol versions. `fails` is what decides: zero is
    // working, and the lowest count is the closest this tracker has come to answering.
    int best_fails = -1;
    bool updating = false;
    bool verified = t.verified;
    int complete = -1, incomplete = -1, downloaded = -1;
    std::int32_t next_in = -1;
    std::string message;
    for (auto const& ep : t.endpoints) {
      for (auto const& ih : ep.info_hashes) {
        if (ih.updating) updating = true;
        if (best_fails < 0 || ih.fails < best_fails) {
          best_fails = ih.fails;
          message = ih.message.empty() && ih.last_error ? ih.last_error.message() : ih.message;
        }
        complete = std::max(complete, ih.scrape_complete);
        incomplete = std::max(incomplete, ih.scrape_incomplete);
        downloaded = std::max(downloaded, ih.scrape_downloaded);
        if (ih.next_announce > now) {
          auto const secs = static_cast<std::int32_t>(
              std::chrono::duration_cast<std::chrono::seconds>(ih.next_announce - now).count());
          if (next_in < 0 || secs < next_in) next_in = secs;
        }
      }
    }
    str(t.url);
    str(message);
    i32(t.tier);
    // -1 when the tracker has never been contacted at all, which is not the same as zero failures
    i32(best_fails);
    u32(updating ? 1u : 0u);
    u32(verified ? 1u : 0u);
    i32(next_in);
    i32(complete);
    i32(incomplete);
    i32(downloaded);
  }
  put_record(REC_TRACKERS, p);
}

}

// call before lt_session_create(); sockets read it at construction
LT_API void lt_set_utp_receive_buffer(std::int32_t bytes) {
  if (bytes > 0) lt::aux::utp_receive_buffer_capacity = bytes;
}

// DHT is on by default and that is what production wants: it is how a magnet with
// no live tracker finds anyone at all.
//
// A local test swarm wants it off, and not merely to be tidy. With it on the
// engine announces the fixture's infohash to the public DHT and gets real peers
// back for it, so a "local" measurement includes strangers who do not have the
// data, real network latency, and an unbounded amount of run-to-run variance.
// Measured on a two-seeder loopback swarm: one run reached metadata in 906 ms,
// the next never reached it at all.
static bool g_dht_enabled = true;
// call before lt_session_create(); read once when the settings pack is built
LT_API void lt_set_dht(int on) {
  g_dht_enabled = on != 0;
}

// Session-wide transfer ceilings, in bytes per second, 0 meaning no ceiling. These are the whole
// session's share rather than one torrent's: libtorrent enforces them through the global peer class,
// so a per-torrent limit set alongside one of these narrows that torrent further and neither
// replaces the other.
//
// Kept in statics as well as applied, because this is the one setter that is useful on both sides of
// lt_session_create(). A caller that has a stored preference wants it in force from the first byte,
// and a caller changing it from a settings screen wants it now; storing and then applying covers
// both without the caller having to know which situation it is in.
static std::int32_t g_download_rate_limit = 0;
static std::int32_t g_upload_rate_limit = 0;

// Whether a ceiling reaches peers on a private address, and it defaults to YES here, which is the
// OPPOSITE of libtorrent's own default. That inversion is deliberate and it is the difference
// between the limit working and silently not.
//
// libtorrent ships ignore_limits_on_local_network = true (settings_pack.cpp:160) and the session
// constructor calls init_peer_class_filter(true) (session_impl.cpp:678), which hands 10/8,
// 172.16/12, 192.168/16, 169.254/16, 127/8, fc00::/7, fe80::/10 and ::1 the LOCAL peer class
// INSTEAD of the global one. The filter assigns rather than accumulates (ip_filter.cpp:216), so
// such a peer carries no global class at all and the session ceiling never touches it. That is a
// sound default for a desktop client on a real LAN, where the point is not to throttle a machine in
// the same building.
//
// It is the wrong default here. This engine reaches its peers through a relay and has no LAN swarm
// to protect, so the only thing the exemption can produce is a user who asked for 1 MB/s, got a peer
// on a private address, and is handed an uncapped transfer with nothing on screen to explain it.
// A ceiling that holds for most peers is a bug, not a feature.
//
// It is also what makes the ceiling measurable at all: the test swarm seeds from 127.0.0.x, so with
// libtorrent's default every rate assertion in tests/rate-limits.test.mjs measures a transfer the
// limiter was never applied to.
static bool g_limit_local_peers = true;

// Negative means leave that setting alone, so any one of the three can be changed without having to
// know the others. Anything else is clamped at 0, which libtorrent reads as unlimited.
LT_API void lt_session_set_rate_limits(std::int32_t download_bps, std::int32_t upload_bps,
                                       std::int32_t limit_local_peers) {
  if (download_bps >= 0) g_download_rate_limit = download_bps;
  if (upload_bps >= 0) g_upload_rate_limit = upload_bps;
  if (limit_local_peers >= 0) g_limit_local_peers = limit_local_peers != 0;
  if (!g_session || !g_session->ses) return;
  lt::settings_pack sp;
  sp.set_int(lt::settings_pack::download_rate_limit, g_download_rate_limit);
  sp.set_int(lt::settings_pack::upload_rate_limit, g_upload_rate_limit);
  // its update callback re-runs init_peer_class_filter (session_impl.cpp:6815), so unlike most of
  // the deprecated settings this one really does take effect on a live session
  sp.set_bool(lt::settings_pack::ignore_limits_on_local_network, !g_limit_local_peers);
  // safe from JS, unlike the matching getters. apply_settings is an async_call, so it posts the pack
  // onto the io_context and returns (session_handle.cpp:1001). torrent_handle::download_limit() and
  // session_handle::get_settings() are sync_call_ret and would block this thread waiting for a
  // context that only runs inside lt_session_tick(), which is the deadlock lt_diag_listen_port()
  // shipped with. Nothing here ever reads a limit back out of the engine for that reason.
  g_session->ses->apply_settings(std::move(sp));
}

// The port named in listen_interfaces. 6882 is a placeholder, not a real port: the shim's bind is
// asynchronous, so getsockname answers before the relay has granted anything and :0 reads back as a
// literal 0, which poisons the tracker announce. A fixed non-zero number was the only way to give
// libtorrent something announceable, at the cost of announcing a port nothing listens on.
//
// lt_set_listen_port replaces the placeholder with a port the host has already bound on the relay
// and is holding open, which is what makes the announced port true and inbound TCP reachable. The
// host learns it by binding first and passes it here, because libtorrent snapshots a listen
// socket's local_endpoint from getsockname between bind and listen (session_impl.cpp:1790) and
// never refreshes it, so a port discovered later can never be announced.
// Zero, not a placeholder number. With no reservation the interfaces string is "0.0.0.0:0", which
// announces as port 1 to trackers (make_announce_port, session_impl.cpp:1279) and omits the BEP-10
// 'p' field entirely (bt_peer_connection.cpp guards on port != 0), so nothing is misdirected. The
// previous 6882 was worse than useless once the relay began honouring named binds: its port space
// is shared by every client of a region, so announcing 6882 pointed trackers and PEX at whichever
// other client happened to be holding it.
static int g_listen_port = 0;
// call before lt_session_create(); read once when the settings pack is built
LT_API void lt_set_listen_port(int port) {
  if (port >= 0 && port < 65536) g_listen_port = port;
}

LT_API int lt_session_create() {
  if (g_session) return -1;

  g_session = new session_state();
  g_session->ioc = std::make_unique<lt::io_context>();

  lt::settings_pack sp;
  // one listen interface is required for outgoing connects, and for the UDP socket that carries uTP and the DHT
  sp.set_str(lt::settings_pack::listen_interfaces, "0.0.0.0:" + std::to_string(g_listen_port));
  sp.set_bool(lt::settings_pack::enable_upnp, false);
  sp.set_bool(lt::settings_pack::enable_natpmp, false);
  sp.set_bool(lt::settings_pack::enable_lsd, false);
  sp.set_int(lt::settings_pack::send_buffer_watermark, 5 * 1024 * 1024);
  sp.set_int(lt::settings_pack::send_buffer_low_watermark, 512 * 1024);
  sp.set_int(lt::settings_pack::send_buffer_watermark_factor, 150);
  // 5000: at 20+ MiB/s x the default request_queue_time of 3s x 16 KiB blocks the desired queue size reaches ~4000; the old 1500 tripped outstanding_request_limit_reached and got peers snubbed because we could not keep them fed
  sp.set_int(lt::settings_pack::max_out_request_queue, 5000);
  sp.set_int(lt::settings_pack::connections_limit, 500);
  sp.set_int(lt::settings_pack::peer_timeout, 240);
  // 30, not the old 120: a peer that stops delivering blocks it already holds is the thing that
  // strands the first pieces of a file. Measured on a well-seeded 1080p MKV, pieces 0-2 took over
  // 72 seconds to arrive while the torrent ran at 10 MB/s, so playback never started at all.
  // 30 also matches the floor patch 0004 applies to peers that have samples.
  sp.set_int(lt::settings_pack::request_timeout, 30);
  // Same failure, the other half. m_last_piece is refreshed by a fragment of ANY piece, so a peer
  // that serves other pieces while sitting on this one never trips the snub at the default 20.
  sp.set_int(lt::settings_pack::piece_timeout, 10);
  // Finish pieces already begun before opening new ones. Off by default, and libtorrent's own
  // high-performance preset turns it on. It adds prioritize_partials to the picker options even in
  // sequential mode, which runs the partial loop ahead of both sequential loops, so a half-finished
  // head piece stops losing to a fresh one further down the file.
  sp.set_bool(lt::settings_pack::prioritize_partial_pieces, true);
  sp.set_int(lt::settings_pack::unchoke_slots_limit, 32);
  // do not switch to peer_proportional: it rate-limits the TCP class (webseeds included), prefer_tcp leaves it uncapped
  sp.set_int(lt::settings_pack::mixed_mode_algorithm, lt::settings_pack::prefer_tcp);
  // LEDBAT target delay (ms), loosened from the default 100 because the constant relay latency otherwise reads as congestion
  sp.set_int(lt::settings_pack::utp_target_delay, 600);
  // WebTransport datagram drops arrive in bursts and are not a real-path congestion signal: soften the multiplicative cut and its cadence, keep RTOs (an RTO resets cwnd to 1 MSS) from firing on relay jitter, and let established peers survive multi-second stalls instead of reconnecting into slow start
  sp.set_int(lt::settings_pack::utp_loss_multiplier, 90);
  sp.set_int(lt::settings_pack::utp_cwnd_reduce_timer, 500);
  sp.set_int(lt::settings_pack::utp_min_timeout, 1200);
  sp.set_int(lt::settings_pack::utp_num_resends, 8);
  sp.set_int(lt::settings_pack::utp_syn_resends, 4);
  sp.set_int(lt::settings_pack::utp_gain_factor, 8000);
  // safe under -sUSE_PTHREADS=0: the bootstrap hostnames resolve through the JS DoH resolver (patch 0001: js_resolver_async -> lt_dns_complete), so libtorrent spawns no resolver thread
  sp.set_bool(lt::settings_pack::enable_dht, g_dht_enabled);
  // left empty when DHT is off so nothing resolves the bootstrap hostnames either
  sp.set_str(lt::settings_pack::dht_bootstrap_nodes,
      g_dht_enabled
        ? "dht.libtorrent.org:25401,router.bittorrent.com:6881,"
          "router.utorrent.com:6881,dht.transmissionbt.com:6881"
        : "");
  // whatever lt_session_set_rate_limits() was last told, so a stored preference is in force before
  // the first torrent is added rather than a tick later
  sp.set_int(lt::settings_pack::download_rate_limit, g_download_rate_limit);
  sp.set_int(lt::settings_pack::upload_rate_limit, g_upload_rate_limit);
  sp.set_bool(lt::settings_pack::ignore_limits_on_local_network, !g_limit_local_peers);
  // pools MUST stay at 0 so nothing tries pthread_create
  sp.set_int(lt::settings_pack::aio_threads, 0);
  sp.set_int(lt::settings_pack::hashing_threads, 0);
  // the *_log categories (session_log, torrent_log, peer_log, dht_log, picker_log) are deliberately absent: each emits dozens of message-rich alerts per tick once a torrent is active, so pop_alerts walks an ever-growing queue and the JS thread spends most of its time draining; enable via lt_session_set_log_verbose() when actively debugging, never by default
  sp.set_int(lt::settings_pack::alert_mask,
      lt::alert_category::error
    | lt::alert_category::peer
    | lt::alert_category::port_mapping
    | lt::alert_category::storage
    | lt::alert_category::tracker
    | lt::alert_category::status
    | lt::alert_category::ip_block
    | lt::alert_category::performance_warning
    | lt::alert_category::dht
    | lt::alert_category::stats);

  lt::session_params params(sp);
  params.disk_io_constructor = lt::wasm_disk_io_constructor;

  LT_LOG("[lt] constructing session…");
  g_session->ses = std::make_unique<lt::session>(std::move(params), *g_session->ioc);
  LT_LOG("[lt] session constructed");

  // required: a thread spawn fails under -sUSE_PTHREADS=0 and session_impl::wrap() reacts by pausing the session
  g_session->ses->resume();

  return 0;
}

LT_API void lt_session_destroy() {
  if (!g_session) return;
  g_session->handles.clear();
  g_session->ses.reset();
  g_session->ioc.reset();
  g_pending_alerts.data.clear();
  delete g_session;
  g_session = nullptr;
}

static std::int64_t g_tick_count = 0;
static std::int64_t g_total_handlers = 0;

LT_API std::int64_t lt_diag_tick_count() { return g_tick_count; }
LT_API std::int64_t lt_diag_total_handlers() { return g_total_handlers; }

#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/ip/udp.hpp>
LT_API int lt_diag_open_tcp() {
  try {
    if (!g_session) return -1;
    boost::asio::ip::tcp::socket s(*g_session->ioc);
    boost::system::error_code ec;
    s.open(boost::asio::ip::tcp::v4(), ec);
    if (ec) return -ec.value();
    int fd = s.native_handle();
    s.close(ec);
    return fd;
  } catch (std::exception const& e) {
    return -9999;
  }
}

LT_API int lt_diag_listen_full() {
  if (!g_session) return -1;
  try {
    boost::asio::ip::tcp::acceptor acc(*g_session->ioc);
    boost::system::error_code ec;
    acc.open(boost::asio::ip::tcp::v4(), ec);
    if (ec) return -100 - ec.value();
    acc.set_option(boost::asio::ip::tcp::acceptor::reuse_address(true), ec);
    boost::asio::ip::tcp::endpoint ep(boost::asio::ip::address_v4::any(), 6881);
    acc.bind(ep, ec);
    if (ec) return -200 - ec.value();
    acc.listen(boost::asio::socket_base::max_listen_connections, ec);
    if (ec) return -300 - ec.value();
    int fd = acc.native_handle();
    acc.close(ec);
    return fd;
  } catch (std::exception const& e) {
    return -9999;
  }
}

LT_API int lt_diag_open_udp() {
  try {
    if (!g_session) return -1;
    boost::asio::ip::udp::socket s(*g_session->ioc);
    boost::system::error_code ec;
    s.open(boost::asio::ip::udp::v4(), ec);
    if (ec) return -ec.value();
    int fd = s.native_handle();
    s.close(ec);
    return fd;
  } catch (std::exception const& e) {
    return -9999;
  }
}

// lt_diag_listen_port() used to live here and was removed rather than fixed. It HUNG THE ENGINE
// FOREVER: session_handle::listen_port() is a sync_call_ret, which posts onto the io_context and
// blocks until it answers, and in this single-threaded build that context only runs inside
// lt_session_tick(). Nothing called it, so the deadlock sat waiting for the first person to reach
// for it while debugging exactly the port question this file is about. The port is available in JS
// without entering wasm at all, from the reservation: see Reachability.port in src/index.ts.

// Reopens the listen sockets. Note this still does NOT move the listen port, and cannot be used to
// correct one after the fact. An earlier version re-applied the same listen_interfaces string, which
// apply_settings_pack_impl gates on setting_changed<std::string>() (session_impl.cpp:1562) and so
// never reopened anything; calling reopen_network_sockets directly clears that gate but lands on a
// second one, since partition_listen_sockets matches on original_port, captured BEFORE the bind, so
// an unchanged interfaces string still leaves every socket matching and nothing is rebuilt.
// Correcting the port late is not a supported operation, which is why it is reserved up front.
// Empty flags rather than the default reopen_map_ports: UPnP and NAT-PMP are both off here
// (settings above), so asking to remap ports would be work with nothing to map.
LT_API void lt_diag_force_reopen() {
  if (!g_session) return;
  g_session->ses->reopen_network_sockets({});
}

#include "libtorrent/string_util.hpp"
LT_API int lt_diag_parse_interfaces(char const* str) {
  if (!str) return -1;
  std::vector<std::string> errors;
  auto ifaces = lt::parse_listen_interfaces(std::string(str), errors);
  for (auto const& e : errors) {
    std::string msg = "parse-error: " + e;
    g_pending_alerts.put_u32(0xFFFFFFF0u);
    g_pending_alerts.put_u32(static_cast<std::uint32_t>(msg.size()));
    g_pending_alerts.put_bytes(msg.data(), msg.size());
  }
  for (auto const& i : ifaces) {
    std::string msg = "iface: device=" + i.device + " port=" + std::to_string(i.port)
                    + " ssl=" + (i.ssl ? "1" : "0") + " local=" + (i.local ? "1" : "0");
    g_pending_alerts.put_u32(0xFFFFFFF1u);
    g_pending_alerts.put_u32(static_cast<std::uint32_t>(msg.size()));
    g_pending_alerts.put_bytes(msg.data(), msg.size());
  }
  return static_cast<int>(ifaces.size());
}

LT_API int lt_session_tick() {
  if (!g_session) return 0;
  // without the guard poll() returns without servicing the select-reactor on Emscripten, wedging inbound UDP
  static auto work_guard = boost::asio::make_work_guard(g_session->ioc->get_executor());
  std::size_t ran = 0;
  try {
    auto const start = std::chrono::steady_clock::now();
    // 100 ms is deliberately generous because libtorrent runs in a dedicated Worker the renderer never sees; smaller budgets bounce control back to JS between tiny batches and cap throughput below what the network feeds us, so do not lower it
    auto const deadline = start + std::chrono::milliseconds(100);
    while (true) {
      std::size_t const n = g_session->ioc->poll();
      ran += n;
      if (n == 0) break;
      if (std::chrono::steady_clock::now() > deadline) break;
    }
    g_total_handlers += static_cast<std::int64_t>(ran);
    ++g_tick_count;
    static auto window_start = start;
    static std::int64_t window_tick_us = 0;
    static std::int64_t window_ticks = 0;
    static std::int64_t window_handlers = 0;
    auto const tick_end = std::chrono::steady_clock::now();
    window_tick_us += std::chrono::duration_cast<std::chrono::microseconds>(tick_end - start).count();
    window_ticks++;
    window_handlers += static_cast<std::int64_t>(ran);
    auto const since_window = std::chrono::duration_cast<std::chrono::seconds>(tick_end - window_start).count();
    if (since_window >= 1) {
      LT_LOG((std::string("[tick] ticks/s=") + std::to_string(window_ticks)
        + " handlers/s=" + std::to_string(window_handlers)
        + " busy_ms=" + std::to_string(window_tick_us / 1000)
        + " avg_us/tick=" + std::to_string(window_ticks ? window_tick_us / window_ticks : 0)
      ).c_str());
      window_start = tick_end;
      window_tick_us = 0;
      window_ticks = 0;
      window_handlers = 0;
    }
  } catch (std::system_error const& e) {
    std::string m = std::string("tick syserr: ") + e.what()
      + " | code=" + std::to_string(e.code().value())
      + " | category=" + e.code().category().name();
    g_pending_alerts.put_u32(0xFFFFFFFFu);
    g_pending_alerts.put_u32(static_cast<std::uint32_t>(m.size()));
    g_pending_alerts.put_bytes(m.data(), m.size());
  } catch (std::exception const& e) {
    std::string m = std::string("tick exc: ") + e.what();
    g_pending_alerts.put_u32(0xFFFFFFFEu);
    g_pending_alerts.put_u32(static_cast<std::uint32_t>(m.size()));
    g_pending_alerts.put_bytes(m.data(), m.size());
  }
  g_session->ioc->restart();
  return static_cast<int>(ran);
}

// placeholder: asio exposes no "time to next timer", so max_ms is deliberately ignored and a fixed 250 returned; -1 means no upcoming timer (use a long sleep)
LT_API int lt_session_next_timer_ms(int max_ms) {
  if (!g_session) return -1;
  (void)max_ms;
  return 250;
}

LT_API void lt_session_pump_alerts() {
  if (!g_session) return;
  std::vector<lt::alert*> alerts;
  g_session->ses->pop_alerts(&alerts);

  for (auto* a : alerts) {
    if (auto* sua = lt::alert_cast<lt::state_update_alert>(a)) { emit_state_update(sua); continue; }
    if (auto* rpa = lt::alert_cast<lt::read_piece_alert>(a)) { emit_read_piece(rpa); continue; }
    if (auto* srda = lt::alert_cast<lt::save_resume_data_alert>(a)) { emit_resume_data(srda); continue; }
    if (lt::alert_cast<lt::save_resume_data_failed_alert>(a)) { continue; }
    // both are replies to an explicit post_*, so they arrive only while a caller is asking; their
    // message() is a bare count and would otherwise flood the text alert stream once per poll
    if (auto* pia = lt::alert_cast<lt::peer_info_alert>(a)) { emit_peers(pia); continue; }
    if (auto* tla = lt::alert_cast<lt::tracker_list_alert>(a)) { emit_trackers(tla); continue; }

    std::string msg = a->message();
    g_pending_alerts.put_u32(static_cast<std::uint32_t>(a->type()));
    g_pending_alerts.put_u32(static_cast<std::uint32_t>(msg.size()));
    g_pending_alerts.put_bytes(msg.data(), msg.size());

    if (auto* ata = lt::alert_cast<lt::add_torrent_alert>(a))
      register_handle(ata->handle);
  }

  // must run AFTER the loop above, so a handle registered from add_torrent_alert resolves by info-hash
  std::uint32_t ready[32];
  std::vector<std::uint32_t> deferred;
  for (int n; (n = lt::wasm_disk_take_ready(ready, 32)) > 0; )
    for (int i = 0; i < n; ++i)
      if (!emit_torrent_ready(ready[i])) deferred.push_back(ready[i]);
  for (auto s : deferred) lt::wasm_disk_requeue_ready(s);
}

LT_API std::uint32_t lt_alerts_size() {
  return static_cast<std::uint32_t>(g_pending_alerts.data.size());
}

LT_API std::uint8_t const* lt_alerts_data() {
  return g_pending_alerts.data.data();
}

LT_API void lt_alerts_clear() {
  g_pending_alerts.data.clear();
}

// the add MUST stay async: the sync add_torrent is a sync_call on an io_context only JS ticks, so it deadlocks
LT_API int lt_session_add_magnet(char const* magnet, char const* save_path) {
  if (!g_session || !magnet) return -1;
  lt::error_code ec;
  lt::add_torrent_params atp = lt::parse_magnet_uri(magnet, ec);
  if (ec) return -2;
  atp.save_path = save_path ? save_path : ".";
  auto const id = id_for_hash(atp.info_hashes.get_best());
  g_session->ses->async_add_torrent(std::move(atp));
  return static_cast<int>(id);
}

LT_API int lt_session_add_torrent_file(
    std::uint8_t const* buf, std::uint32_t len, char const* save_path) {
  if (!g_session || !buf || !len) return -1;
  lt::error_code ec;
  auto ti = std::make_shared<lt::torrent_info>(
      reinterpret_cast<char const*>(buf), static_cast<int>(len), ec);
  if (ec) return -2;
  lt::add_torrent_params atp;
  atp.ti = std::move(ti);
  atp.save_path = save_path ? save_path : ".";
  auto const id = id_for_hash(atp.ti->info_hashes().get_best());
  g_session->ses->async_add_torrent(std::move(atp));
  return static_cast<int>(id);
}

LT_API int lt_session_remove_torrent(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h) return -1;
  g_session->ses->remove_torrent(*h);
  g_session->handles.erase(id);
  g_session->geometry.erase(id);
  return 0;
}

LT_API int lt_session_remove_torrent_ex(std::uint32_t id, int delete_files) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h) return -1;
  lt::remove_flags_t flags = {};
  if (delete_files) flags = lt::session_handle::delete_files;
  g_session->ses->remove_torrent(*h, flags);
  g_session->handles.erase(id);
  g_session->geometry.erase(id);
  return 0;
}

// order matters: unset auto_managed first or the queue logic auto-resumes it
LT_API int lt_torrent_pause(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h) return -1;
  h->unset_flags(lt::torrent_flags::auto_managed);
  h->pause();
  return 0;
}

LT_API int lt_torrent_resume(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h) return -1;
  h->set_flags(lt::torrent_flags::auto_managed);
  h->resume();
  return 0;
}

// should_check_files only schedules the hash pass for a torrent that is neither paused nor errored, hence the resume first
LT_API int lt_torrent_force_recheck(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h) return -1;
  h->set_flags(lt::torrent_flags::auto_managed);
  h->resume();
  h->force_recheck();
  return 0;
}

LT_API int lt_torrent_save_resume_data(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h) return -1;
  h->save_resume_data(lt::torrent_handle::save_info_dict);
  return 0;
}

// no_verify_files makes libtorrent TRUST the resume have-bitmask against the files on disk: no recheck, no re-download
LT_API int lt_session_add_torrent_with_resume(
    std::uint8_t const* buf, std::uint32_t len, char const* save_path) {
  if (!g_session || !buf || !len) return -1;
  lt::error_code ec;
  lt::add_torrent_params atp = lt::read_resume_data(
      {reinterpret_cast<char const*>(buf), static_cast<std::ptrdiff_t>(len)}, ec);
  if (ec) return -2;
  if (save_path && *save_path) atp.save_path = save_path;
  atp.flags |= lt::torrent_flags::no_verify_files;
  auto const hid = id_for_hash(atp.info_hashes.get_best());
  g_session->ses->async_add_torrent(std::move(atp));
  return static_cast<int>(hid);
}

// POD-flat layout, read field by field via DataView in js/index.ts
struct torrent_status_out {
  std::int32_t  state;
  std::int32_t  paused;
  float         progress;
  std::int64_t  total_download;
  std::int64_t  total_upload;
  std::int64_t  total_done;
  std::int64_t  total_wanted;
  std::int64_t  total_payload_download;
  std::int64_t  total_payload_upload;
  std::int32_t  download_rate;
  std::int32_t  upload_rate;
  std::int32_t  download_payload_rate;
  std::int32_t  upload_payload_rate;
  std::int32_t  num_peers;
  std::int32_t  num_seeds;
  std::int32_t  num_pieces;
  std::int32_t  num_connections;
  std::int32_t  has_metadata;
};

// never call h->status() instead: every synchronous libtorrent getter sync_calls an io_context that only runs when JS ticks
LT_API int lt_torrent_post_status(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->post_status();
  return 0;
}

// stub kept for ABI compatibility; always returns -1 in the async model
LT_API int lt_torrent_status(std::uint32_t id, torrent_status_out* out) {
  (void)id; (void)out;
  return -1;
}

/**
 * Ask for the peer list. The answer arrives as a REC_PEERS record on the alert stream.
 *
 * Async for the same reason status is, and it is not a preference: `h->get_peer_info()` is a
 * sync_call on an io_context that only runs inside lt_session_tick(), so calling it from JS blocks
 * the thread that would have to tick for it to return. That deadlock is not hypothetical here,
 * lt_diag_listen_port() shipped with exactly it and hung forever.
 */
LT_API int lt_torrent_post_peers(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->post_peer_info();
  return 0;
}

// see lt_torrent_post_peers: h->trackers() is a sync_call and would deadlock the same way
LT_API int lt_torrent_post_trackers(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->post_trackers();
  return 0;
}

/**
 * The torrent's identity, as hex. WRITES UP TO 65 BYTES into `out`: 64 hex + NUL.
 *
 * Two things were wrong here and each on its own was fatal.
 *
 * It took `ih.v2` whenever there was one, then cut the result to 40 characters with `out[40] = 0`.
 * That yielded the first 20 bytes of a SHA-256 formatted exactly like a v1 infohash: a string that
 * names no torrent, that the caller then used as the torrent's identity everywhere, and that went
 * into a `magnet:?xt=urn:btih:` link no client can resolve.
 *
 * And `to_hex` writes `size * 2` characters PLUS a NUL at `out[size * 2]`, so a 32-byte hash writes
 * 65 bytes into what callers allocated as 41: twenty-four bytes past the end of the allocation, on
 * every call for a torrent with a v2 hash.
 *
 * V1 WINS WHEREVER THERE IS ONE. A hybrid torrent has both hashes and is one torrent, so which one
 * comes back cannot depend on the caller. The v1 hash is the one every client understands and the
 * one the caller's own metainfo decoder computes, so returning it keeps the two paths agreeing about
 * which torrent this is. A v2-only torrent answers with 64 characters.
 */
LT_API int lt_torrent_infohash(std::uint32_t id, char* out) {
  if (!g_session || !out) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  auto ih = h->info_hashes();
  // to_hex NUL-terminates at the real width, so nothing here truncates
  lt::aux::to_hex(ih.has_v1() ? ih.v1.to_string() : ih.v2.to_string(), out);
  return 0;
}

/**
 * The v2 hash on its own, 64 hex + NUL, or -1 when this torrent has none.
 *
 * Separate from the call above rather than folded into it, because a hybrid has to be able to answer
 * BOTH: the v1 hash is its identity and the v2 hash still belongs in its magnet, so a v2-aware
 * client can reach the same swarm.
 */
LT_API int lt_torrent_infohash_v2(std::uint32_t id, char* out) {
  if (!g_session || !out) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  auto ih = h->info_hashes();
  if (!ih.has_v2()) return -1;
  lt::aux::to_hex(ih.v2.to_string(), out);
  return 0;
}

// set_sequential_download() is ABI-v1-only; the modern path is set/unset_flags(sequential_download)
LT_API int lt_torrent_set_sequential(std::uint32_t id, int on) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  if (on) h->set_flags(lt::torrent_flags::sequential_download);
  else    h->unset_flags(lt::torrent_flags::sequential_download);
  return 0;
}

/**
 * Set and clear torrent flags in one call: `mask` names the bits to touch, `flags` their new value.
 *
 * A mask rather than a pair of set/unset calls because these are read-modify-write on a live
 * torrent, and two calls is two chances for a status update to land in between showing a state
 * neither call intended.
 *
 * 32 bits, not 64. `torrent_flags_t` is a uint64 bitfield and every flag libtorrent defines lives
 * at bit 24 or below (torrent_flags.hpp:66-306), so a u32 carries all of them and avoids splitting
 * the value into i32 pairs for a WASM_BIGINT=0 build. If libtorrent ever defines bit 32 this has to
 * become a pair; the static_assert below is what will say so at compile time rather than in the
 * field.
 */
static_assert(static_cast<std::uint64_t>(lt::torrent_flags::i2p_torrent) < (std::uint64_t{1} << 32),
    "a torrent flag now lives above bit 31; lt_torrent_set_flags must carry 64 bits");

LT_API int lt_torrent_set_flags(std::uint32_t id, std::uint32_t flags, std::uint32_t mask) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->set_flags(lt::torrent_flags_t(static_cast<std::uint64_t>(flags)),
               lt::torrent_flags_t(static_cast<std::uint64_t>(mask)));
  return 0;
}

/**
 * Announce again now rather than at the next interval.
 *
 * `seconds = 0` means immediately. libtorrent rate limits this internally, so a user leaning on the
 * menu item cannot turn it into a flood aimed at a tracker.
 */
LT_API int lt_torrent_force_reannounce(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->force_reannounce();
  return 0;
}

// 0 top, 1 up, 2 down, 3 bottom. Position is only meaningful for an auto-managed torrent, which is
// why the caller is expected to hide this when the queue is not what is holding the torrent back.
LT_API int lt_torrent_queue_position(std::uint32_t id, int where) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  switch (where) {
    case 0: h->queue_position_top(); break;
    case 1: h->queue_position_up(); break;
    case 2: h->queue_position_down(); break;
    case 3: h->queue_position_bottom(); break;
    default: return -1;
  }
  return 0;
}

// bytes per second, 0 for unlimited. Per torrent, and independent of the relay's own metering.
LT_API int lt_torrent_set_upload_limit(std::uint32_t id, std::int32_t bytes_per_second) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->set_upload_limit(bytes_per_second);
  return 0;
}

LT_API int lt_torrent_set_download_limit(std::uint32_t id, std::int32_t bytes_per_second) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->set_download_limit(bytes_per_second);
  return 0;
}

LT_API int lt_torrent_read_piece(std::uint32_t id, std::int32_t piece) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->read_piece(lt::piece_index_t{piece});
  return 0;
}

LT_API int lt_torrent_set_piece_deadline(std::uint32_t id, std::int32_t piece,
                                         std::int32_t deadline_ms, int alert_when_available) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  lt::deadline_flags_t flags{};
  if (alert_when_available) flags = lt::torrent_handle::alert_when_available;
  h->set_piece_deadline(lt::piece_index_t{piece}, deadline_ms, flags);
  return 0;
}

// Drops EVERY deadline on the torrent and demotes each cleared piece to priority 1, not back to the
// default 4. So a caller that clears and then re-prioritizes must do it in that order; the reverse
// silently undoes the priorities it just wrote.
LT_API int lt_torrent_clear_piece_deadlines(std::uint32_t id) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  h->clear_piece_deadlines();
  return 0;
}

// Retires one piece from the time-critical set, leaving the others alone. Without this the only
// way to drop an abandoned deadline is clear_piece_deadlines(), which takes the whole set with it.
// Like that call it also drops the piece to priority 1, so the caller has to put back whatever
// priority it wanted the piece to keep.
LT_API int lt_torrent_reset_piece_deadline(std::uint32_t id, std::int32_t piece) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  auto const* geo = geometry_for(id);
  if (!geo || piece < 0 || piece >= geo->num_pieces) return -1;
  h->reset_piece_deadline(lt::piece_index_t{piece});
  return 0;
}

static inline lt::download_priority_t clamp_prio(std::uint8_t v) {
  // the field is 3 bits wide, so 8 would store as 0 and silently mark the piece as never-download
  return lt::download_priority_t{static_cast<std::uint8_t>(v > 7 ? 7 : v)};
}

// prios encoding: 0=skip, 1=low, 4=default, 7=top. Positional from piece 0; pieces beyond `count`
// keep their priority. `count` is clamped to the torrent's piece count because libtorrent applies
// this vector with no bound of its own and its asserts are compiled out here, so an over-long array
// would write past piece_picker::m_piece_map. Returns -1 before the torrent-ready record lands,
// since the piece count needed for that clamp is not known yet.
LT_API int lt_torrent_prioritize_pieces(std::uint32_t id,
                                        std::uint8_t const* prios, std::uint32_t count) {
  if (!g_session || !prios) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  auto const* geo = geometry_for(id);
  if (!geo) return -1;
  if (count > static_cast<std::uint32_t>(geo->num_pieces))
    count = static_cast<std::uint32_t>(geo->num_pieces);
  std::vector<lt::download_priority_t> v(count);
  for (std::uint32_t i = 0; i < count; ++i) v[i] = clamp_prio(prios[i]);
  h->prioritize_pieces(v);
  return 0;
}

// Sparse form: only the listed pieces change, every other piece keeps its priority. It avoids
// rewriting the whole map, so this is the call for a window that moves with the playhead.
// Requires metadata, and filters the indices itself: unlike the positional overload this path has
// no metadata guard inside libtorrent, and it reaches need_picker(), which builds a picker out of a
// zero piece length and then divides by it. Returns -1 before the torrent-ready record lands.
LT_API int lt_torrent_prioritize_piece_list(std::uint32_t id, std::int32_t const* pieces,
                                            std::uint8_t const* prios, std::uint32_t count) {
  if (!g_session || !pieces || !prios) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  auto const* geo = geometry_for(id);
  if (!geo) return -1;
  std::vector<std::pair<lt::piece_index_t, lt::download_priority_t>> v;
  v.reserve(count);
  for (std::uint32_t i = 0; i < count; ++i) {
    if (pieces[i] < 0 || pieces[i] >= geo->num_pieces) continue;
    v.emplace_back(lt::piece_index_t{pieces[i]}, clamp_prio(prios[i]));
  }
  if (v.empty()) return 0;
  h->prioritize_pieces(v);
  return 0;
}

// Same encoding as the piece priorities, one byte per file. libtorrent resizes this vector to the
// file count itself, padding with the default 4, so a short array silently resets the files it
// omits: always send one byte per file. Setting any file priority also rewrites every piece
// priority to match, so piece-level priorities have to be re-applied after this.
LT_API int lt_torrent_prioritize_files(std::uint32_t id,
                                       std::uint8_t const* prios, std::uint32_t count) {
  if (!g_session || !prios) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  std::vector<lt::download_priority_t> v(count);
  for (std::uint32_t i = 0; i < count; ++i) v[i] = clamp_prio(prios[i]);
  h->prioritize_files(v);
  return 0;
}

// Take a piece back from whatever peers are sitting on it, by cancelling every outstanding request
// for its blocks so any peer may pick them again.
//
// This exists because nothing else can do it. cancel_non_critical() cancels stale requests but
// deliberately SKIPS pieces in m_time_critical_pieces, so a piece that has been deadlined (which is
// how a streaming client says "I need this now") is precisely the piece it will not reclaim. The
// duplicate-request path that would otherwise rescue it is gated behind m_average_piece_time > 0,
// which stays 0 until a deadlined piece has already completed, so it is inert during startup. That
// leaves only the snub and request timeouts, i.e. tens of seconds, for a piece playback is blocked
// on. Callers should reach for this only for a read that has already waited.
//
// Deferred onto the io_context rather than run inline: every other entry point here goes through
// torrent_handle's async_call, and native_handle() would bypass that. This keeps the same
// discipline, and mirrors how libtorrent defers its own cancel_non_critical.
LT_API int lt_torrent_cancel_piece_requests(std::uint32_t id, std::int32_t piece) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  auto const* geo = geometry_for(id);
  if (!geo || piece < 0 || piece >= geo->num_pieces) return -1;
  auto t = h->native_handle();
  if (!t) return -1;
  boost::asio::post(*g_session->ioc, [t, piece] {
    // a torrent that finished has no picker, and cancel_request would dereference it
    if (!t->has_picker()) return;
    lt::piece_index_t const idx{piece};
    // NOT torrent::cancel_block(): it calls cancel_request(block) with force defaulted to false,
    // and for a block already ON THE WIRE that only sets not_wanted and writes a wire CANCEL, with
    // picker().abort_download() sitting behind `if (force)`. The picker therefore still counts every
    // block as requested, the piece stays piece_full, and piece_full reports priority -1, which
    // removes it from m_pieces entirely and makes add_blocks refuse it. So the piece stays invisible
    // to every picking path and the cancel achieves nothing at all. Measured 2026-08-11: 28 rounds
    // of it over 168 s never freed the piece a read was parked on.
    //
    // Reaching the peers directly and forcing the release is what cancel_non_critical() does, and
    // once the blocks are genuinely released abort_download re-adds the piece to m_pieces at top
    // priority, where the next request_a_block hands it out.
    for (auto* p : *t) {
      // copied, because cancel_request erases from the queue we would be iterating
      auto const dq = p->download_queue();
      for (auto const& k : dq) {
        if (k.block.piece_index != idx) continue;
        // Same filter cancel_non_critical uses, and it is not optional here: a caller retries this
        // every few seconds, and aborting an already-released block a second time decrements
        // num_peers for a peer the picker no longer associates with it, freeing the block out from
        // under whoever holds it now.
        if (k.not_wanted || k.timed_out) continue;
        p->cancel_request(k.block, true);
      }
      auto const rq = p->request_queue();
      for (auto const& k : rq) {
        if (k.block.piece_index != idx) continue;
        p->cancel_request(k.block, true);
      }
    }
  });
  return 0;
}

LT_API int lt_torrent_set_file_priority(std::uint32_t id, std::int32_t file, std::uint8_t prio) {
  if (!g_session) return -1;
  auto* h = lookup_handle(id);
  if (!h || !h->is_valid()) return -1;
  // libtorrent deliberately supports selecting a file before metadata arrives, so only bound the
  // index once the file count is actually known
  auto const* geo = geometry_for(id);
  if (file < 0 || (geo && file >= geo->num_files)) return -1;
  h->file_priority(lt::file_index_t{file}, clamp_prio(prio));
  return 0;
}
