#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace usee::recorder_host {

inline constexpr std::wstring_view kWaveformFileName = L"waveform.json";
inline constexpr std::wstring_view kWaveformPartialFileName = L"waveform.partial.json";
inline constexpr unsigned kWaveformPeaksPerSecond = 100;

// The peak absolute amplitude of each bucket of interleaved 16-bit PCM, over
// all channels, scaled to 0-255.
class PeakAccumulator {
 public:
  PeakAccumulator(unsigned sample_rate, unsigned channels, unsigned peaks_per_second);

  void add(const std::int16_t* samples, std::uint32_t frames);
  void add_silence(std::int64_t frames);
  // Closes a final partial bucket and returns all peaks.
  std::vector<std::uint8_t> finish();

 private:
  void close_bucket();

  std::uint32_t frames_per_peak_;
  unsigned channels_;
  std::uint32_t frames_in_bucket_ = 0;
  int bucket_peak_ = 0;
  std::vector<std::uint8_t> peaks_;
};

std::string base64_encode(const std::vector<std::uint8_t>& bytes);

struct WaveformInfo {
  std::int64_t peak_count = 0;
  unsigned peaks_per_second = kWaveformPeaksPerSecond;
};

// Decodes the first audio stream of `media` and writes `waveform.json` beside
// it, with the provenance docs/project-format.md asks of derived artifacts.
// Throws HostError.
WaveformInfo write_waveform(const std::filesystem::path& media, std::string_view media_sha256);

}  // namespace usee::recorder_host
