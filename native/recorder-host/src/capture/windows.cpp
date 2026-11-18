#include "pch.h"

#include "capture/windows.h"

#include <dwmapi.h>

#include <cstdio>

#include "util/utf.h"

namespace usee::recorder_host {

std::string window_id(HWND window) {
  char id[32]{};
  std::snprintf(id, sizeof(id), "window-%016llx",
                static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(window)));
  return id;
}

std::string picker_title(std::wstring_view title) {
  constexpr std::size_t kMaxTitleUnits = 128;
  const auto is_high = [](wchar_t unit) { return unit >= 0xD800 && unit <= 0xDBFF; };
  const auto is_low = [](wchar_t unit) { return unit >= 0xDC00 && unit <= 0xDFFF; };
  std::wstring kept(title.substr(0, kMaxTitleUnits));
  if (title.size() > kMaxTitleUnits && is_high(kept.back())) {
    kept.pop_back();
  }
  for (std::size_t i = 0; i < kept.size(); ++i) {
    if (is_high(kept[i]) && i + 1 < kept.size() && is_low(kept[i + 1])) {
      ++i;
    } else if (is_high(kept[i]) || is_low(kept[i])) {
      kept[i] = L'�';
    }
  }
  return to_utf8(kept);
}

RECT window_frame_bounds(HWND window) {
  RECT bounds{};
  if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds))) &&
      !GetWindowRect(window, &bounds)) {
    return RECT{};
  }
  return bounds;
}

namespace {

struct Enumeration {
  DWORD excluded_process = 0;
  std::vector<WindowInfo> windows;
};

bool is_choosable(HWND window, DWORD excluded_process) {
  if (!IsWindowVisible(window) || IsIconic(window) || GetWindowTextLengthW(window) == 0) {
    return false;
  }
  if ((GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) {
    return false;
  }
  // Windows the shell hides (other virtual desktops, suspended apps) report as visible.
  DWORD cloaked = 0;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) &&
      cloaked != 0) {
    return false;
  }
  DWORD process = 0;
  GetWindowThreadProcessId(window, &process);
  return process != excluded_process || excluded_process == 0;
}

}  // namespace

std::vector<WindowInfo> enumerate_windows(DWORD excluded_process) {
  Enumeration enumeration{excluded_process, {}};
  EnumWindows(
      [](HWND window, LPARAM user_data) -> BOOL {
        auto& found = *reinterpret_cast<Enumeration*>(user_data);
        if (!is_choosable(window, found.excluded_process)) {
          return TRUE;
        }
        const RECT bounds = window_frame_bounds(window);
        if (bounds.right - bounds.left < 2 || bounds.bottom - bounds.top < 2) {
          return TRUE;
        }
        std::wstring title(static_cast<std::size_t>(GetWindowTextLengthW(window)) + 1, L'\0');
        title.resize(static_cast<std::size_t>(
            GetWindowTextW(window, title.data(), static_cast<int>(title.size()))));
        if (title.empty()) {
          return TRUE;
        }
        WindowInfo info;
        info.id = window_id(window);
        info.title = picker_title(title);
        info.hwnd = window;
        info.width = static_cast<unsigned>(bounds.right - bounds.left);
        info.height = static_cast<unsigned>(bounds.bottom - bounds.top);
        found.windows.push_back(std::move(info));
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&enumeration));
  return enumeration.windows;
}

}  // namespace usee::recorder_host
