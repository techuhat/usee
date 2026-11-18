#include "pch.h"

// Define (not just declare) PKEY_Device_FriendlyName in this translation unit.
#include <initguid.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>

#include "audio/microphone_capture.h"

#include "capture/displays.h"
#include "util/utf.h"

namespace usee::recorder_host {

namespace {

void check_audio(HRESULT hr, const char* code, bool retryable = true) {
  check_hr(hr, ErrorCategory::audio, code, retryable);
}

winrt::com_ptr<IMMDeviceEnumerator> device_enumerator() {
  winrt::com_ptr<IMMDeviceEnumerator> enumerator;
  check_audio(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                               __uuidof(IMMDeviceEnumerator), enumerator.put_void()),
              "audio.enumeration-failed");
  return enumerator;
}

std::wstring device_id(IMMDevice* device) {
  LPWSTR raw = nullptr;
  if (FAILED(device->GetId(&raw)) || raw == nullptr) {
    return {};
  }
  std::wstring id{raw};
  CoTaskMemFree(raw);
  return id;
}

std::string friendly_name(IMMDevice* device) {
  winrt::com_ptr<IPropertyStore> properties;
  if (FAILED(device->OpenPropertyStore(STGM_READ, properties.put()))) {
    return "Microphone";
  }
  PROPVARIANT value;
  PropVariantInit(&value);
  std::string name = "Microphone";
  if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) &&
      value.vt == VT_LPWSTR && value.pwszVal != nullptr) {
    name = to_utf8(value.pwszVal);
  }
  PropVariantClear(&value);
  return name;
}

WAVEFORMATEX pcm_format() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kAudioChannels;
  format.nSamplesPerSec = kAudioSampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

}  // namespace

std::vector<AudioInputInfo> enumerate_audio_inputs() {
  const auto enumerator = device_enumerator();
  std::wstring default_id;
  winrt::com_ptr<IMMDevice> default_device;
  if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, default_device.put()))) {
    default_id = device_id(default_device.get());
  }

  winrt::com_ptr<IMMDeviceCollection> collection;
  check_audio(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, collection.put()),
              "audio.enumeration-failed");
  UINT count = 0;
  check_audio(collection->GetCount(&count), "audio.enumeration-failed");

  std::vector<AudioInputInfo> inputs;
  for (UINT index = 0; index < count; ++index) {
    winrt::com_ptr<IMMDevice> device;
    if (FAILED(collection->Item(index, device.put()))) {
      continue;
    }
    AudioInputInfo info;
    info.endpoint_id = device_id(device.get());
    if (info.endpoint_id.empty()) {
      continue;
    }
    info.id = stable_id("audio", info.endpoint_id);
    info.name = friendly_name(device.get());
    info.is_default = info.endpoint_id == default_id;
    inputs.push_back(std::move(info));
  }
  return inputs;
}

MicrophoneCapture::MicrophoneCapture(const std::wstring& endpoint_id, AudioPacketCallback on_packet,
                                     AudioLostCallback on_lost)
    : on_packet_(std::move(on_packet)), on_lost_(std::move(on_lost)) {
  const auto enumerator = device_enumerator();
  winrt::com_ptr<IMMDevice> device;
  check_audio(enumerator->GetDevice(endpoint_id.c_str(), device.put()), "audio.device-unavailable");
  check_audio(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, client_.put_void()),
              "audio.device-unavailable");

  const WAVEFORMATEX format = pcm_format();
  constexpr REFERENCE_TIME kBufferHns = 2'000'000;  // 200 ms
  check_audio(client_->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                      AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                  kBufferHns, 0, &format, nullptr),
              "audio.format-unsupported", false);

  ready_event_.attach(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (!ready_event_) {
    check_audio(HRESULT_FROM_WIN32(GetLastError()), "audio.device-unavailable");
  }
  check_audio(client_->SetEventHandle(ready_event_.get()), "audio.device-unavailable");
  check_audio(client_->GetService(__uuidof(IAudioCaptureClient), capture_.put_void()),
              "audio.device-unavailable");
}

MicrophoneCapture::~MicrophoneCapture() { stop(); }

void MicrophoneCapture::start() {
  check_audio(client_->Start(), "audio.device-unavailable");
  running_ = true;
  thread_ = std::thread([this] { run(); });
}

void MicrophoneCapture::stop() noexcept {
  running_ = false;
  if (thread_.joinable()) {
    thread_.join();
  }
  if (client_) {
    client_->Stop();
  }
}

void MicrophoneCapture::run() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  DWORD task_index = 0;
  const HANDLE task = AvSetMmThreadCharacteristicsW(L"Audio", &task_index);
  std::vector<std::int16_t> silence;

  try {
    while (running_) {
      if (WaitForSingleObject(ready_event_.get(), 200) != WAIT_OBJECT_0) {
        continue;
      }
      UINT32 frames_available = 0;
      check_audio(capture_->GetNextPacketSize(&frames_available), "audio.device-lost");
      while (frames_available > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        UINT64 device_position = 0;
        UINT64 qpc_position = 0;
        check_audio(capture_->GetBuffer(&data, &frames, &flags, &device_position, &qpc_position),
                    "audio.device-lost");

        const std::int16_t* samples = reinterpret_cast<const std::int16_t*>(data);
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
          silence.assign(static_cast<size_t>(frames) * kAudioChannels, 0);
          samples = silence.data();
        }
        on_packet_(samples, frames, static_cast<std::int64_t>(qpc_position),
                   (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0);

        check_audio(capture_->ReleaseBuffer(frames), "audio.device-lost");
        check_audio(capture_->GetNextPacketSize(&frames_available), "audio.device-lost");
      }
    }
  } catch (const HostError& error) {
    running_ = false;
    if (on_lost_) {
      on_lost_(error);
    }
  }

  if (task != nullptr) {
    AvRevertMmThreadCharacteristics(task);
  }
  CoUninitialize();
}

}  // namespace usee::recorder_host
