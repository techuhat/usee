#pragma once

#include <atomic>
#include <string>
#include <thread>
#include <vector>

#include "audio/audio_source.h"

namespace usee::recorder_host {

struct AudioInputInfo {
  // "audio-<8 hex>", derived from the endpoint ID, which stays in the host.
  std::string id;
  // Friendly name for the device picker. Never logged (docs/logging.md).
  std::string name;
  bool is_default = false;
  std::wstring endpoint_id;
};

std::vector<AudioInputInfo> enumerate_audio_inputs();

// Event-driven shared-mode WASAPI capture on an MMCSS "Audio" thread.
class MicrophoneCapture final : public AudioSource {
 public:
  MicrophoneCapture(const std::wstring& endpoint_id, AudioPacketCallback on_packet,
                    AudioLostCallback on_lost);
  ~MicrophoneCapture() override;

  void start() override;
  void stop() noexcept override;

 private:
  void run();

  winrt::com_ptr<IAudioClient> client_;
  winrt::com_ptr<IAudioCaptureClient> capture_;
  winrt::handle ready_event_;
  AudioPacketCallback on_packet_;
  AudioLostCallback on_lost_;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

}  // namespace usee::recorder_host
