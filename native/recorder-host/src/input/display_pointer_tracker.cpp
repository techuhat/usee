#include "pch.h"

#include "input/display_pointer_tracker.h"

#include "capture/windows.h"

#include "session/media_clock.h"
#include "util/host_error.h"
#include "util/log.h"

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

namespace usee::recorder_host {

namespace {

constexpr LONG kPollPeriodMs = 8;  // about 120 Hz
constexpr wchar_t kWindowClass[] = L"UseePointerTracker";

struct ButtonFlag {
  USHORT down;
  USHORT up;
  const char* name;
};

constexpr ButtonFlag kButtons[] = {
    {RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_LEFT_BUTTON_UP, "left"},
    {RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_UP, "right"},
    {RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_UP, "middle"},
    {RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP, "x1"},
    {RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_BUTTON_5_UP, "x2"},
};

}  // namespace

const char* cursor_shape_name(HCURSOR cursor) noexcept {
  struct Known {
    LPCWSTR id;
    const char* name;
  };
  // MAKEINTRESOURCE is a cast, so the table cannot be constexpr.
  static const Known kKnown[] = {
      {IDC_ARROW, "arrow"},          {IDC_IBEAM, "text"},           {IDC_HAND, "pointer"},
      {IDC_WAIT, "wait"},            {IDC_APPSTARTING, "progress"}, {IDC_CROSS, "crosshair"},
      {IDC_SIZEWE, "ew-resize"},     {IDC_SIZENS, "ns-resize"},     {IDC_SIZENWSE, "nwse-resize"},
      {IDC_SIZENESW, "nesw-resize"}, {IDC_SIZEALL, "move"},         {IDC_NO, "not-allowed"},
      {IDC_HELP, "help"},
  };
  // Shared system cursors keep one handle for the session, so comparing handles is enough.
  for (const Known& known : kKnown) {
    if (cursor != nullptr && cursor == LoadCursorW(nullptr, known.id)) {
      return known.name;
    }
  }
  return "arrow";
}

DisplayPointerTracker::DisplayPointerTracker(HMONITOR monitor, PointerEventCallback on_event,
                                             std::optional<FrameRegion> region)
    : on_event_(std::move(on_event)) {
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) {
    throw HostError(ErrorCategory::capture, "capture.source-unavailable", true);
  }
  bounds_ = info.rcMonitor;
  if (region) {
    // The host is per-monitor DPI aware, so the monitor's rectangle is in its pixels too.
    const RECT display = bounds_;
    bounds_.left = display.left + static_cast<LONG>(region->x);
    bounds_.top = display.top + static_cast<LONG>(region->y);
    bounds_.right = bounds_.left + static_cast<LONG>(region->width);
    bounds_.bottom = bounds_.top + static_cast<LONG>(region->height);
  }
  create_stop_event();
}

DisplayPointerTracker::DisplayPointerTracker(HWND window, PointerEventCallback on_event)
    : on_event_(std::move(on_event)), window_(window) {
  bounds_ = window_frame_bounds(window);
  if (bounds_.right <= bounds_.left || bounds_.bottom <= bounds_.top) {
    throw HostError(ErrorCategory::capture, "capture.source-unavailable", true);
  }
  create_stop_event();
}

void DisplayPointerTracker::create_stop_event() {
  stop_event_.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!stop_event_) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::native, "native.event-failed");
  }
}

RECT DisplayPointerTracker::current_bounds() const {
  if (window_ == nullptr) {
    return bounds_;
  }
  // A closed window keeps its last place; the recording is ending anyway.
  const RECT bounds = window_frame_bounds(window_);
  return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : bounds_;
}

DisplayPointerTracker::~DisplayPointerTracker() { stop(); }

void DisplayPointerTracker::start() {
  thread_ = std::thread([this] { run(); });
}

void DisplayPointerTracker::stop() noexcept {
  if (stop_event_) {
    SetEvent(stop_event_.get());
  }
  if (thread_.joinable()) {
    thread_.join();
  }
}

PointerEvent DisplayPointerTracker::at_cursor(PointerEventType type, std::int64_t now_hns) const {
  POINT position{};
  GetCursorPos(&position);
  const RECT bounds = current_bounds();
  PointerEvent event;
  event.type = type;
  event.qpc_hns = now_hns;
  event.x = static_cast<double>(position.x - bounds.left) / (bounds.right - bounds.left);
  event.y = static_cast<double>(position.y - bounds.top) / (bounds.bottom - bounds.top);
  return event;
}

void DisplayPointerTracker::poll(std::int64_t now_hns) {
  CURSORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetCursorInfo(&info)) {
    return;  // a secure desktop, such as the UAC prompt, hides the cursor from us
  }
  const bool visible = (info.flags & CURSOR_SHOWING) != 0;
  if (first_poll_ || visible != last_visible_) {
    PointerEvent event;
    event.type = PointerEventType::visibility;
    event.qpc_hns = now_hns;
    event.visible = visible;
    on_event_(event);
    last_visible_ = visible;
  }
  if (visible && (first_poll_ || info.hCursor != last_cursor_)) {
    PointerEvent event;
    event.type = PointerEventType::shape;
    event.qpc_hns = now_hns;
    event.shape = cursor_shape_name(info.hCursor);
    on_event_(event);
    last_cursor_ = info.hCursor;
  }
  if (first_poll_ || info.ptScreenPos.x != last_position_.x ||
      info.ptScreenPos.y != last_position_.y) {
    const RECT bounds = current_bounds();
    PointerEvent event;
    event.type = PointerEventType::move;
    event.qpc_hns = now_hns;
    event.x = static_cast<double>(info.ptScreenPos.x - bounds.left) / (bounds.right - bounds.left);
    event.y = static_cast<double>(info.ptScreenPos.y - bounds.top) / (bounds.bottom - bounds.top);
    on_event_(event);
    last_position_ = info.ptScreenPos;
  }
  first_poll_ = false;
}

void DisplayPointerTracker::emit_buttons(USHORT flags, std::int64_t now_hns) {
  for (const ButtonFlag& button : kButtons) {
    if ((flags & button.down) != 0) {
      PointerEvent event = at_cursor(PointerEventType::down, now_hns);
      event.button = button.name;
      on_event_(event);
    }
    if ((flags & button.up) != 0) {
      PointerEvent event = at_cursor(PointerEventType::up, now_hns);
      event.button = button.name;
      on_event_(event);
    }
  }
}

void DisplayPointerTracker::run() {
  const HINSTANCE instance = GetModuleHandleW(nullptr);
  WNDCLASSEXW window_class{};
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = DefWindowProcW;
  window_class.hInstance = instance;
  window_class.lpszClassName = kWindowClass;
  RegisterClassExW(&window_class);  // already registered by an earlier session is fine
  const HWND window = CreateWindowExW(0, kWindowClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr,
                                      instance, nullptr);
  // Generic desktop page (1), mouse usage (2): buttons arrive while other apps have focus.
  RAWINPUTDEVICE mouse{0x01, 0x02, RIDEV_INPUTSINK, window};
  const bool raw_input = window != nullptr && RegisterRawInputDevices(&mouse, 1, sizeof(mouse));
  if (!raw_input) {
    log_event(LogLevel::warn, "session.pointer.buttons-unavailable");
  }

  winrt::handle timer{CreateWaitableTimerExW(nullptr, nullptr,
                                             CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                             TIMER_ALL_ACCESS)};
  if (!timer) {
    timer.attach(CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS));
  }
  LARGE_INTEGER due{};
  due.QuadPart = -10'000LL * kPollPeriodMs;
  SetWaitableTimer(timer.get(), &due, kPollPeriodMs, nullptr, nullptr, FALSE);

  const HANDLE handles[] = {stop_event_.get(), timer.get()};
  poll(qpc_now_hns());
  std::vector<BYTE> buffer;
  for (;;) {
    const DWORD wait = MsgWaitForMultipleObjectsEx(2, handles, INFINITE, QS_RAWINPUT,
                                                   MWMO_INPUTAVAILABLE);
    if (wait == WAIT_OBJECT_0 || wait == WAIT_FAILED) {
      break;
    }
    const std::int64_t now = qpc_now_hns();
    if (wait == WAIT_OBJECT_0 + 2) {
      MSG message{};
      while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (message.message == WM_INPUT) {
          UINT size = 0;
          const auto input = reinterpret_cast<HRAWINPUT>(message.lParam);
          GetRawInputData(input, RID_INPUT, nullptr, &size, sizeof(RAWINPUTHEADER));
          buffer.resize(size);
          if (size >= sizeof(RAWINPUTHEADER) &&
              GetRawInputData(input, RID_INPUT, buffer.data(), &size, sizeof(RAWINPUTHEADER)) ==
                  size) {
            const auto* raw = reinterpret_cast<const RAWINPUT*>(buffer.data());
            if (raw->header.dwType == RIM_TYPEMOUSE) {
              emit_buttons(raw->data.mouse.usButtonFlags, now);
            }
          }
        }
        // DefWindowProc releases the raw input buffer.
        DispatchMessageW(&message);
      }
    }
    poll(now);
  }

  CancelWaitableTimer(timer.get());
  if (raw_input) {
    RAWINPUTDEVICE remove{0x01, 0x02, RIDEV_REMOVE, nullptr};
    RegisterRawInputDevices(&remove, 1, sizeof(remove));
  }
  if (window != nullptr) {
    DestroyWindow(window);
  }
}

}  // namespace usee::recorder_host
