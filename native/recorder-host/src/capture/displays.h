#pragma once

#include <string>
#include <vector>

namespace usee::recorder_host {

struct DisplayInfo {
  // "display-<8 hex>", stable while the display topology is unchanged.
  std::string id;
  // "Display 1"; the GDI device name stays inside the host.
  std::string name;
  HMONITOR monitor = nullptr;
  RECT bounds{};
  bool is_primary = false;
  int refresh_rate_hz = 0;
};

std::vector<DisplayInfo> enumerate_displays();

// FNV-1a over UTF-16 code units, formatted as 8 lowercase hex digits. Used to
// derive opaque, stable device IDs without exposing device names.
std::string stable_id(std::string_view prefix, std::wstring_view key);

}  // namespace usee::recorder_host
