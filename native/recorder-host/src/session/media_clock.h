#pragma once

#include <cstdint>

namespace usee::recorder_host {

// Media Foundation, Windows Graphics Capture and WASAPI all report time in
// 100-nanosecond units ("hns") on the QueryPerformanceCounter timeline, so the
// session clock is QPC expressed in hns.
inline constexpr std::int64_t kHnsPerSecond = 10'000'000;

std::int64_t qpc_now_hns() noexcept;

inline constexpr std::int64_t hns_to_us(std::int64_t hns) noexcept { return hns / 10; }

// Presentation time of frame `index` at `numerator/denominator` fps, in hns.
// Exact integer arithmetic: 60 fps alternates 166666 and 166667 hns per frame
// instead of drifting.
inline constexpr std::int64_t frame_time_hns(std::int64_t index, std::int64_t numerator,
                                             std::int64_t denominator) noexcept {
  return index * kHnsPerSecond * denominator / numerator;
}

// Index of the latest frame whose presentation time is <= `elapsed_hns`: the
// exact inverse of frame_time_hns, which rounds down. floor(i*T) <= t holds
// exactly when i*T < t + 1, so the answer is ceil((t + 1) / T) - 1.
inline constexpr std::int64_t frame_index_at(std::int64_t elapsed_hns, std::int64_t numerator,
                                             std::int64_t denominator) noexcept {
  return elapsed_hns <= 0 ? 0
                          : ((elapsed_hns + 1) * numerator - 1) / (kHnsPerSecond * denominator);
}

// Duration of `frames` audio frames at `sample_rate`, in hns, exactly rounded down.
inline constexpr std::int64_t audio_frames_to_hns(std::int64_t frames,
                                                  std::int64_t sample_rate) noexcept {
  return frames * kHnsPerSecond / sample_rate;
}

}  // namespace usee::recorder_host
