#pragma once

#include <string>
#include <string_view>

#include "protocol/json.h"
#include "util/host_error.h"

namespace usee::recorder_host {

inline constexpr int kProtocolMajor = 1;
inline constexpr int kProtocolMinor = 3;
inline constexpr std::string_view kHostVersion = "0.4.0";

struct Request {
  std::string id;
  std::string method;
  json::JsonObject params{nullptr};
};

// Parses `{"kind":"request","id":…,"method":…,"params":{…}}`. Throws
// ProtocolViolation for anything else; the connection is then closed.
Request parse_request(std::string_view payload);

std::string make_ok_response(std::string_view id, const json::JsonObject& result);
std::string make_error_response(std::string_view id, const HostError& error);
std::string make_event(std::string_view name, const json::JsonObject& data);

// True for 1-64 characters of [A-Za-z0-9_-] that start with a letter or digit;
// used for request IDs and session IDs alike.
bool is_opaque_id(std::string_view value) noexcept;

}  // namespace usee::recorder_host
