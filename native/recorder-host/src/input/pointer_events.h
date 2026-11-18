#pragma once

#include <cstdint>
#include <functional>
#include <string_view>

namespace usee::recorder_host {

inline constexpr std::wstring_view kPointerFileName = L"pointer.ndjson";

enum class PointerEventType { move, down, up, shape, visibility };

// One pointer observation. Positions are normalized to the captured display
// (0-1 across its width and height) and may fall outside it when the pointer
// leaves the display. Keyboard input is never recorded.
struct PointerEvent {
  PointerEventType type = PointerEventType::move;
  std::int64_t qpc_hns = 0;
  double x = 0.0;
  double y = 0.0;
  // `down` and `up`: "left", "right", "middle", "x1" or "x2".
  const char* button = nullptr;
  // `shape`: a standard cursor kind such as "arrow" or "text".
  const char* shape = nullptr;
  // `visibility`.
  bool visible = true;
};

// Called on the source's own thread, in time order.
using PointerEventCallback = std::function<void(const PointerEvent& event)>;

class PointerSource {
 public:
  virtual ~PointerSource() = default;
  virtual void start() = 0;
  virtual void stop() noexcept = 0;
};

}  // namespace usee::recorder_host
