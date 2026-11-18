#pragma once

#include <filesystem>
#include <string>
#include <string_view>

namespace usee::recorder_host {

// Launch configuration. Electron main passes it through the environment, never
// the command line (docs/ipc.md): the pipe name and token are per-launch
// secrets, and the staging root is the only directory the host writes to.
struct HostConfig {
  std::wstring pipe_name;
  std::string token;
  std::filesystem::path staging_root;
  bool synthetic_source_enabled = false;
};

// Reads and validates USEE_PIPE_NAME, USEE_HOST_TOKEN,
// USEE_STAGING_ROOT and USEE_SYNTHETIC_SOURCE, then removes
// the token from the process environment. Throws std::invalid_argument.
HostConfig read_host_config_from_environment();

// Exposed for tests.
bool is_valid_pipe_name(std::wstring_view name) noexcept;
bool is_valid_token(std::string_view token) noexcept;
bool is_acceptable_staging_root(const std::filesystem::path& path);

// Constant-time comparison of two tokens.
bool tokens_equal(std::string_view expected, std::string_view actual) noexcept;

// `root / session_id` after checking the ID cannot name a path segment.
std::filesystem::path session_directory(const std::filesystem::path& root,
                                        std::string_view session_id);

}  // namespace usee::recorder_host
