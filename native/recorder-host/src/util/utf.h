#pragma once

#include <string>
#include <string_view>

namespace usee::recorder_host {

// Strict conversions: invalid input throws std::invalid_argument rather than
// being replaced, because protocol text must round-trip exactly.
std::string to_utf8(std::wstring_view text);
std::wstring to_wide(std::string_view text);

}  // namespace usee::recorder_host
