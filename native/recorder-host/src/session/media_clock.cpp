#include "pch.h"

#include "session/media_clock.h"

namespace usee::recorder_host {

std::int64_t qpc_now_hns() noexcept {
  static const std::int64_t frequency = [] {
    LARGE_INTEGER value{};
    QueryPerformanceFrequency(&value);
    return value.QuadPart;
  }();
  LARGE_INTEGER counter{};
  QueryPerformanceCounter(&counter);
  const std::int64_t ticks = counter.QuadPart;
  // Split to avoid overflowing ticks * 10^7 on long uptimes.
  return (ticks / frequency) * kHnsPerSecond + (ticks % frequency) * kHnsPerSecond / frequency;
}

}  // namespace usee::recorder_host
