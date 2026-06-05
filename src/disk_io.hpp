#pragma once

#include <cstdint>
#include <memory>
#include "libtorrent/io_context.hpp"
#include "libtorrent/disk_interface.hpp"
#include "libtorrent/settings_pack.hpp"
#include "libtorrent/sha1_hash.hpp"

namespace libtorrent {

struct counters;
struct file_storage;

// Factory installed into session_params::disk_io_constructor. Bridges every
// async disk op out to JS callbacks defined in js/library_fkn.js, then
// completes them asynchronously when JS calls back into the module.
std::unique_ptr<disk_interface> wasm_disk_io_constructor(
    io_context& ios, settings_interface const&, counters& cnt);

// --- streaming-read bridge (wrapper.cpp ↔ disk_io.cpp) ---------------------
// The disk_io holds the only deadlock-free source of a torrent's file layout +
// piece geometry (the file_storage it is handed at storage construction, which
// is fully populated post-metadata for magnets too). The wrapper joins a
// storage to its torrent_handle by info_hash (== storage_params.info_hash ==
// handle.info_hashes().get_best()). These hooks expose that to the wrapper.

// Per-storage geometry. `fs` is valid until the torrent's remove_torrent.
struct wasm_storage_info {
  sha1_hash info_hash;
  file_storage const* fs;
  char const* save_path;
};

// Drain storage_index values whose file_storage became available since the last
// call (i.e. notify_js_new fired). Returns how many were written to `out`.
int wasm_disk_take_ready(std::uint32_t* out, int max);

// Re-queue a storage_index the wrapper couldn't emit yet (handle not registered
// at drain time). Picked up on a later pump — NOT the current one.
void wasm_disk_requeue_ready(std::uint32_t storage_index);

// Look up cached geometry for a storage_index. Returns 0 on success.
int wasm_disk_storage_info(std::uint32_t storage_index, wasm_storage_info* out);

} // namespace libtorrent
