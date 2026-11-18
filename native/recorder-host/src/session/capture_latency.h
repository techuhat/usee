#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <optional>

namespace usee::recorder_host {

// How much older than its frame time the picture in a frame is: its frame
// time minus the time Windows gives the frame (`SystemRelativeTime`, when it
// is shown), so negative for a picture shown after the frame time it is
// encoded at. The editor reads the pointer that much earlier (or later), so
// the cursor and the picture show the same moment (ADR-010). Kept as a
// histogram of whole milliseconds from a quarter second before to three
// quarters after, so a session of any length takes the same memory.
class CaptureLatencyMeter {
 public:
  void add(std::int64_t age_hns) noexcept {
    if (age_hns < 0) {
      ++newer_;
    }
    youngest_hns_ = total_ == 0 ? age_hns : std::min(youngest_hns_, age_hns);
    // Whole milliseconds, rounded down, so -0.5 ms counts as -1 ms, not 0.
    const std::int64_t ms = age_hns >= 0 ? age_hns / 10'000 : -((-age_hns + 9'999) / 10'000);
    const std::int64_t bucket = std::clamp<std::int64_t>(ms - kLowestMs, 0, kBuckets - 1);
    ++counts_[static_cast<std::size_t>(bucket)];
    ++total_;
  }

  // The age `share` (0-1) of the pictures are at most, in microseconds at the
  // middle of its millisecond; none before the first picture.
  std::optional<std::int64_t> percentile_us(double share) const noexcept {
    if (total_ == 0) {
      return std::nullopt;
    }
    const double wanted = std::clamp(share, 0.0, 1.0) * static_cast<double>(total_);
    std::uint64_t seen = 0;
    for (std::size_t bucket = 0; bucket < counts_.size(); ++bucket) {
      seen += counts_[bucket];
      if (static_cast<double>(seen) >= wanted && seen > 0) {
        return (static_cast<std::int64_t>(bucket) + kLowestMs) * 1'000 + 500;
      }
    }
    return (kBuckets - 1 + kLowestMs) * 1'000 + 500;
  }

  std::optional<std::int64_t> median_us() const noexcept { return percentile_us(0.5); }

  // How many pictures were measured, and how many were shown after their frame time.
  std::uint64_t samples() const noexcept { return total_; }
  std::uint64_t newer() const noexcept { return newer_; }
  // The smallest age seen, in microseconds.
  std::int64_t youngest_us() const noexcept { return youngest_hns_ / 10; }

 private:
  static constexpr std::int64_t kLowestMs = -250;
  static constexpr std::int64_t kBuckets = 1'000;  // -250 ms to +750 ms
  std::array<std::uint64_t, kBuckets> counts_{};
  std::uint64_t total_ = 0;
  std::uint64_t newer_ = 0;
  std::int64_t youngest_hns_ = 0;
};

}  // namespace usee::recorder_host
