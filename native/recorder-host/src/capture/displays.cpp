#include "pch.h"

#include "capture/displays.h"

#include <cstdio>

namespace usee::recorder_host {

std::string stable_id(std::string_view prefix, std::wstring_view key) {
  std::uint32_t hash = 2166136261u;
  for (const wchar_t unit : key) {
    hash ^= static_cast<std::uint32_t>(unit);
    hash *= 16777619u;
  }
  char suffix[9]{};
  std::snprintf(suffix, sizeof(suffix), "%08x", hash);
  return std::string(prefix) + "-" + suffix;
}

std::vector<DisplayInfo> enumerate_displays() {
  std::vector<DisplayInfo> displays;
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR monitor, HDC, LPRECT, LPARAM user_data) -> BOOL {
        auto& list = *reinterpret_cast<std::vector<DisplayInfo>*>(user_data);
        MONITORINFOEXW info{};
        info.cbSize = sizeof(info);
        if (!GetMonitorInfoW(monitor, &info)) {
          return TRUE;
        }

        DEVMODEW mode{};
        mode.dmSize = sizeof(mode);
        const int refresh =
            EnumDisplaySettingsW(info.szDevice, ENUM_CURRENT_SETTINGS, &mode)
                ? static_cast<int>(mode.dmDisplayFrequency)
                : 0;

        DisplayInfo display;
        display.id = stable_id("display", info.szDevice);
        display.name = "Display " + std::to_string(list.size() + 1);
        display.monitor = monitor;
        display.bounds = info.rcMonitor;
        display.is_primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
        display.refresh_rate_hz = refresh;
        list.push_back(std::move(display));
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&displays));
  return displays;
}

}  // namespace usee::recorder_host
