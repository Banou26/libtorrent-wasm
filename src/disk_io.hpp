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

std::unique_ptr<disk_interface> wasm_disk_io_constructor(
    io_context& ios, settings_interface const&, counters& cnt);

// info_hash == storage_params.info_hash == handle.info_hashes().get_best(); `fs` is valid until the torrent's remove_torrent.
struct wasm_storage_info {
  sha1_hash info_hash;
  file_storage const* fs;
  char const* save_path;
};

// returns how many storage_index values were written to `out`
int wasm_disk_take_ready(std::uint32_t* out, int max);

// Picked up on a later pump - NOT the current one.
void wasm_disk_requeue_ready(std::uint32_t storage_index);

// returns 0 on success, not a bool
int wasm_disk_storage_info(std::uint32_t storage_index, wasm_storage_info* out);

} // namespace libtorrent
