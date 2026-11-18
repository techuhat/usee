#pragma once

#include <filesystem>
#include <string>

namespace usee::recorder_host {

struct FileDigest {
  std::string sha256_hex;
  std::uint64_t bytes = 0;
};

// SHA-256 of a whole file using CNG (bcrypt). Throws HostError (storage).
FileDigest hash_file(const std::filesystem::path& path);

}  // namespace usee::recorder_host
