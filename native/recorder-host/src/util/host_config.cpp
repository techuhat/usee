#include "pch.h"

#include "util/host_config.h"

#include "protocol/messages.h"
#include "util/utf.h"

namespace usee::recorder_host {

namespace {

constexpr std::wstring_view kPipePrefix = L"\\\\.\\pipe\\usee-recorder-";

std::optional<std::wstring> read_variable(const wchar_t* name) {
  const DWORD length = GetEnvironmentVariableW(name, nullptr, 0);
  if (length == 0) {
    return std::nullopt;
  }
  std::wstring value(length, L'\0');
  const DWORD written = GetEnvironmentVariableW(name, value.data(), length);
  value.resize(written);
  return value;
}

bool is_lower_hex(wchar_t c) noexcept { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); }

}  // namespace

bool is_valid_pipe_name(std::wstring_view name) noexcept {
  if (name.size() != kPipePrefix.size() + 32 || name.substr(0, kPipePrefix.size()) != kPipePrefix) {
    return false;
  }
  const auto nonce = name.substr(kPipePrefix.size());
  return std::all_of(nonce.begin(), nonce.end(), is_lower_hex);
}

bool is_valid_token(std::string_view token) noexcept {
  return token.size() == 64 && std::all_of(token.begin(), token.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
}

bool is_acceptable_staging_root(const std::filesystem::path& path) {
  const std::wstring& text = path.native();
  // Only a plain local drive path: no UNC shares, device or \\?\ namespaces.
  if (text.size() < 3 || text[1] != L':' || (text[2] != L'\\' && text[2] != L'/')) {
    return false;
  }
  std::error_code error;
  return path.is_absolute() && std::filesystem::is_directory(path, error);
}

bool tokens_equal(std::string_view expected, std::string_view actual) noexcept {
  if (expected.size() != actual.size()) {
    return false;
  }
  unsigned char difference = 0;
  for (size_t index = 0; index < expected.size(); ++index) {
    difference |= static_cast<unsigned char>(expected[index] ^ actual[index]);
  }
  return difference == 0;
}

std::filesystem::path session_directory(const std::filesystem::path& root,
                                        std::string_view session_id) {
  if (!is_opaque_id(session_id)) {
    throw std::invalid_argument("Session ID is not an opaque identifier.");
  }
  return root / to_wide(session_id);
}

HostConfig read_host_config_from_environment() {
  HostConfig config;

  const auto pipe_name = read_variable(L"USEE_PIPE_NAME");
  if (!pipe_name || !is_valid_pipe_name(*pipe_name)) {
    throw std::invalid_argument("USEE_PIPE_NAME is missing or malformed.");
  }
  config.pipe_name = *pipe_name;

  const auto token = read_variable(L"USEE_HOST_TOKEN");
  if (!token) {
    throw std::invalid_argument("USEE_HOST_TOKEN is missing.");
  }
  config.token = to_utf8(*token);
  if (!is_valid_token(config.token)) {
    throw std::invalid_argument("USEE_HOST_TOKEN is malformed.");
  }
  // The token is needed only for the handshake; keep it out of the environment block.
  SetEnvironmentVariableW(L"USEE_HOST_TOKEN", nullptr);

  const auto staging_root = read_variable(L"USEE_STAGING_ROOT");
  if (!staging_root) {
    throw std::invalid_argument("USEE_STAGING_ROOT is missing.");
  }
  config.staging_root = std::filesystem::path(*staging_root).lexically_normal();
  if (!is_acceptable_staging_root(config.staging_root)) {
    throw std::invalid_argument("USEE_STAGING_ROOT must be an existing local directory.");
  }

  const auto synthetic = read_variable(L"USEE_SYNTHETIC_SOURCE");
  config.synthetic_source_enabled = synthetic.has_value() && *synthetic == L"1";
  return config;
}

}  // namespace usee::recorder_host
