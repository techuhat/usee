#pragma once

#include <cstdint>
#include <functional>

#include "util/host_error.h"

namespace usee::recorder_host {

// 48 kHz, stereo, 16-bit PCM: WASAPI converts the device mix to this format.
inline constexpr unsigned kAudioSampleRate = 48'000;
inline constexpr unsigned kAudioChannels = 2;

// `samples` holds `frames` interleaved frames; `qpc_hns` is the capture time of
// the first frame. `discontinuity` marks a gap reported by the device.
using AudioPacketCallback = std::function<void(const std::int16_t* samples, std::uint32_t frames,
                                               std::int64_t qpc_hns, bool discontinuity)>;
using AudioLostCallback = std::function<void(const HostError& error)>;

// Delivers PCM packets on its own thread until stopped.
class AudioSource {
 public:
  virtual ~AudioSource() = default;
  virtual void start() = 0;
  virtual void stop() noexcept = 0;
};

}  // namespace usee::recorder_host
