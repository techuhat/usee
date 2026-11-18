#include "pch.h"

#include "input/synthetic_pointer.h"

#include <cmath>

#include "session/media_clock.h"

namespace usee::recorder_host {

namespace {

constexpr std::int64_t kLapHns = 4 * kHnsPerSecond;
constexpr std::int64_t kClickPeriodHns = kHnsPerSecond;
constexpr std::int64_t kClickAtHns = kHnsPerSecond / 2;
constexpr std::int64_t kClickLengthHns = kHnsPerSecond / 10;
constexpr std::int64_t kTickHns = kHnsPerSecond / 120;

}  // namespace

SyntheticPointerState synthetic_pointer_at(std::int64_t elapsed_hns) noexcept {
  constexpr double kTwoPi = 6.283185307179586;
  const std::int64_t lap = elapsed_hns % kLapHns;
  const double angle = kTwoPi * static_cast<double>(lap) / static_cast<double>(kLapHns);
  const std::int64_t within_second = elapsed_hns % kClickPeriodHns;
  SyntheticPointerState state;
  state.x = 0.5 + 0.3 * std::cos(angle);
  state.y = 0.5 + 0.3 * std::sin(angle);
  state.pressed = within_second >= kClickAtHns && within_second < kClickAtHns + kClickLengthHns;
  state.shape = lap >= kLapHns / 2 ? "pointer" : "arrow";
  return state;
}

SyntheticPointer::SyntheticPointer(PointerEventCallback on_event, std::int64_t epoch_hns)
    : on_event_(std::move(on_event)), epoch_hns_(epoch_hns) {}

SyntheticPointer::~SyntheticPointer() { stop(); }

void SyntheticPointer::start() {
  running_ = true;
  thread_ = std::thread([this] { run(); });
}

void SyntheticPointer::stop() noexcept {
  running_ = false;
  if (thread_.joinable()) {
    thread_.join();
  }
}

void SyntheticPointer::run() {
  // Ticks already due when the thread starts are emitted at once, so the
  // stream begins at the epoch.
  const std::int64_t origin = epoch_hns_;
  SyntheticPointerState previous;
  bool first = true;
  for (std::int64_t tick = 0; running_; ++tick) {
    const std::int64_t due = origin + tick * kTickHns;
    const std::int64_t wait = due - qpc_now_hns();
    if (wait > 0) {
      std::this_thread::sleep_for(std::chrono::microseconds(wait / 10));
    }
    const SyntheticPointerState state = synthetic_pointer_at(tick * kTickHns);
    PointerEvent event;
    event.qpc_hns = due;
    event.x = state.x;
    event.y = state.y;
    if (first) {
      PointerEvent visible = event;
      visible.type = PointerEventType::visibility;
      on_event_(visible);
    }
    if (first || std::string_view(state.shape) != previous.shape) {
      PointerEvent shape = event;
      shape.type = PointerEventType::shape;
      shape.shape = state.shape;
      on_event_(shape);
    }
    event.type = PointerEventType::move;
    on_event_(event);
    if (!first && state.pressed != previous.pressed) {
      PointerEvent button = event;
      button.type = state.pressed ? PointerEventType::down : PointerEventType::up;
      button.button = "left";
      on_event_(button);
    }
    previous = state;
    first = false;
  }
}

}  // namespace usee::recorder_host
