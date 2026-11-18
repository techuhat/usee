#include "pch.h"

#include "audio/synthetic_audio_source.h"

#include <cmath>

#include "session/media_clock.h"

namespace usee::recorder_host {

std::int16_t synthetic_audio_sample(std::int64_t frame) noexcept {
  // 440 whole cycles a second, so the signal repeats every second exactly and
  // the phase stays precise however long the recording runs.
  const std::int64_t within_second = frame % kAudioSampleRate;
  if (within_second >= kAudioSampleRate / 2) {
    return 0;
  }
  constexpr double kTwoPi = 6.283185307179586;
  const double phase = kTwoPi * 440.0 * static_cast<double>(within_second) / kAudioSampleRate;
  return static_cast<std::int16_t>(8192.0 * std::sin(phase));  // -12 dBFS
}

SyntheticAudioSource::SyntheticAudioSource(AudioPacketCallback on_packet)
    : on_packet_(std::move(on_packet)) {}

SyntheticAudioSource::~SyntheticAudioSource() { stop(); }

void SyntheticAudioSource::start() {
  running_ = true;
  thread_ = std::thread([this] { run(); });
}

void SyntheticAudioSource::stop() noexcept {
  running_ = false;
  if (thread_.joinable()) {
    thread_.join();
  }
}

void SyntheticAudioSource::run() {
  constexpr std::uint32_t kPacketFrames = kAudioSampleRate / 100;
  std::vector<std::int16_t> packet(static_cast<size_t>(kPacketFrames) * kAudioChannels);
  const std::int64_t origin = qpc_now_hns();
  std::int64_t position = 0;

  while (running_) {
    // Like a capture device, deliver each packet once its last frame is due.
    const std::int64_t due = origin + audio_frames_to_hns(position + kPacketFrames, kAudioSampleRate);
    const std::int64_t wait = due - qpc_now_hns();
    if (wait > 0) {
      std::this_thread::sleep_for(std::chrono::microseconds(wait / 10));
    }
    for (std::uint32_t frame = 0; frame < kPacketFrames; ++frame) {
      const std::int16_t value = synthetic_audio_sample(position + frame);
      for (unsigned channel = 0; channel < kAudioChannels; ++channel) {
        packet[static_cast<size_t>(frame) * kAudioChannels + channel] = value;
      }
    }
    on_packet_(packet.data(), kPacketFrames,
               origin + audio_frames_to_hns(position, kAudioSampleRate), false);
    position += kPacketFrames;
  }
}

}  // namespace usee::recorder_host
