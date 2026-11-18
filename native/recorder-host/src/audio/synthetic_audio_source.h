#pragma once

#include <atomic>
#include <string_view>
#include <thread>

#include "audio/audio_source.h"

namespace usee::recorder_host {

// A test signal in place of a microphone: a 440 Hz tone for the first half of
// every second and silence for the second half, in 10 ms packets on the QPC
// clock as WASAPI delivers them. Automated tests record it instead of a real
// device (docs/testing.md).
class SyntheticAudioSource final : public AudioSource {
 public:
  static constexpr std::string_view kInputId = "synthetic-audio";

  explicit SyntheticAudioSource(AudioPacketCallback on_packet);
  ~SyntheticAudioSource() override;

  void start() override;
  void stop() noexcept override;

 private:
  void run();

  AudioPacketCallback on_packet_;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

// The signal's value at `frame` frames after the source started; both
// channels carry it. Exposed for tests.
std::int16_t synthetic_audio_sample(std::int64_t frame) noexcept;

}  // namespace usee::recorder_host
