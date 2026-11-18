#pragma once

#include <atomic>
#include <thread>

#include "input/pointer_events.h"

namespace usee::recorder_host {

// A deterministic pointer in place of the real mouse, for tests: it circles
// the frame every 4 seconds of the session clock, clicks once a second, and
// shows the hand cursor for the second half of each lap, so it is at the same
// place at the same moment of every recording. Tests never read real input
// (docs/testing.md).
class SyntheticPointer final : public PointerSource {
 public:
  SyntheticPointer(PointerEventCallback on_event, std::int64_t epoch_hns);
  ~SyntheticPointer() override;

  void start() override;
  void stop() noexcept override;

 private:
  void run();

  PointerEventCallback on_event_;
  std::int64_t epoch_hns_;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

struct SyntheticPointerState {
  double x = 0.5;
  double y = 0.5;
  bool pressed = false;
  const char* shape = "arrow";
};

// The synthetic pointer `elapsed_hns` into the session. Exposed for tests.
SyntheticPointerState synthetic_pointer_at(std::int64_t elapsed_hns) noexcept;

}  // namespace usee::recorder_host
