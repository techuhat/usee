#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace usee::recorder_host {

// A top-level window a user could choose to record (ADR-009).
struct WindowInfo {
  // "window-<16 hex>", from the window's handle: valid while the window exists.
  std::string id;
  // UTF-8, for the picker only: never written to the journal or the log.
  std::string title;
  HWND hwnd = nullptr;
  unsigned width = 0;
  unsigned height = 0;
};

// The windows a user would choose: top-level, visible, not minimized, not
// cloaked by the shell, titled, not tool windows, and not of `excluded_process`
// (usee's own). Ordered as Windows stacks them, front first.
std::vector<WindowInfo> enumerate_windows(DWORD excluded_process);

std::string window_id(HWND window);

// A title as the picker shows it, in UTF-8: at most 128 UTF-16 units, cut
// between characters, with lone surrogates replaced, so any title converts
// and a full list fits one protocol frame.
std::string picker_title(std::wstring_view title);

// The window as Windows composes it on screen (its extended frame bounds,
// without the drop shadow), or an empty rectangle once it has closed.
RECT window_frame_bounds(HWND window);

}  // namespace usee::recorder_host
