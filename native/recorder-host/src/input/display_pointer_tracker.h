#pragma once

#include <optional>
#include <thread>

#include "capture/frame_source.h"
#include "input/pointer_events.h"

namespace usee::recorder_host {

// Follows the real pointer over one display or one window: position and
// cursor shape polled at 120 Hz, buttons from raw mouse input on a
// message-only window, so they arrive even while another application has
// focus. Only the mouse is registered; keyboard input is never read.
class DisplayPointerTracker final : public PointerSource {
 public:
  // Normalized to `region` of the display, in its pixels, when one is given (ADR-009).
  DisplayPointerTracker(HMONITOR monitor, PointerEventCallback on_event,
                        std::optional<FrameRegion> region = std::nullopt);
  // Normalized to the window's frame as it is at each poll: the window may move.
  DisplayPointerTracker(HWND window, PointerEventCallback on_event);
  ~DisplayPointerTracker() override;

  void start() override;
  void stop() noexcept override;

 private:
  void run();
  void poll(std::int64_t now_hns);
  void emit_buttons(USHORT flags, std::int64_t now_hns);
  PointerEvent at_cursor(PointerEventType type, std::int64_t now_hns) const;
  void create_stop_event();
  RECT current_bounds() const;

  RECT bounds_{};
  PointerEventCallback on_event_;
  HWND window_ = nullptr;
  winrt::handle stop_event_;
  std::thread thread_;

  // Tracker thread only.
  bool first_poll_ = true;
  POINT last_position_{};
  HCURSOR last_cursor_ = nullptr;
  bool last_visible_ = true;
};

// The standard kind of a cursor handle ("arrow", "text", "pointer", …); a
// cursor an application drew itself counts as "arrow". Exposed for tests.
const char* cursor_shape_name(HCURSOR cursor) noexcept;

}  // namespace usee::recorder_host
