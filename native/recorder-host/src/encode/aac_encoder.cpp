#include "pch.h"

#include "encode/aac_encoder.h"

#include <cstring>

#include "session/media_clock.h"
#include "util/host_error.h"

namespace usee::recorder_host {

namespace {

void check_encoding(HRESULT hr, const char* code) { check_hr(hr, ErrorCategory::encoding, code); }

winrt::com_ptr<IMFMediaType> audio_type(const GUID& subtype, unsigned sample_rate,
                                        unsigned channels) {
  winrt::com_ptr<IMFMediaType> type;
  check_encoding(MFCreateMediaType(type.put()), "encoding.media-type-failed");
  check_encoding(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio), "encoding.media-type-failed");
  check_encoding(type->SetGUID(MF_MT_SUBTYPE, subtype), "encoding.media-type-failed");
  check_encoding(type->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16), "encoding.media-type-failed");
  check_encoding(type->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate),
                 "encoding.media-type-failed");
  check_encoding(type->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels), "encoding.media-type-failed");
  return type;
}

winrt::com_ptr<IMFTransform> create_aac_transform() {
  MFT_REGISTER_TYPE_INFO input{MFMediaType_Audio, MFAudioFormat_PCM};
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Audio, MFAudioFormat_AAC};
  IMFActivate** activates = nullptr;
  UINT32 count = 0;
  check_encoding(MFTEnumEx(MFT_CATEGORY_AUDIO_ENCODER,
                           MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER,
                           &input, &output, &activates, &count),
                 "encoding.encoder-unavailable");

  winrt::com_ptr<IMFTransform> transform;
  HRESULT hr = count == 0 ? MF_E_TOPO_CODEC_NOT_FOUND
                          : activates[0]->ActivateObject(IID_PPV_ARGS(transform.put()));
  for (UINT32 index = 0; index < count; ++index) {
    activates[index]->Release();
  }
  CoTaskMemFree(activates);
  check_encoding(hr, "encoding.encoder-unavailable");
  return transform;
}

}  // namespace

AacEncoder::AacEncoder(unsigned sample_rate, unsigned channels)
    : transform_(create_aac_transform()), sample_rate_(sample_rate), channels_(channels) {
  auto output = audio_type(MFAudioFormat_AAC, sample_rate, channels);
  // 160 kbps; the Microsoft encoder accepts 12000/16000/20000/24000 bytes per second.
  check_encoding(output->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 20'000),
                 "encoding.media-type-failed");
  check_encoding(output->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0), "encoding.media-type-failed");

  auto input = audio_type(MFAudioFormat_PCM, sample_rate, channels);
  const UINT32 block_align = channels * 2;
  check_encoding(input->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, block_align),
                 "encoding.media-type-failed");
  check_encoding(input->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sample_rate * block_align),
                 "encoding.media-type-failed");

  // Encoders differ in which type they want first; accept either order.
  if (SUCCEEDED(transform_->SetOutputType(0, output.get(), 0))) {
    check_encoding(transform_->SetInputType(0, input.get(), 0), "encoding.encoder-unavailable");
  } else {
    check_encoding(transform_->SetInputType(0, input.get(), 0), "encoding.encoder-unavailable");
    check_encoding(transform_->SetOutputType(0, output.get(), 0), "encoding.encoder-unavailable");
  }
  check_encoding(transform_->GetOutputCurrentType(0, output_type_.put()),
                 "encoding.encoder-unavailable");

  MFT_OUTPUT_STREAM_INFO info{};
  check_encoding(transform_->GetOutputStreamInfo(0, &info), "encoding.encoder-unavailable");
  output_buffer_bytes_ = std::max<DWORD>(info.cbSize, 8'192);
  transform_allocates_output_ =
      (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;

  check_encoding(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0),
                 "encoding.encoder-unavailable");
  check_encoding(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0),
                 "encoding.encoder-unavailable");
}

AacEncoder::~AacEncoder() = default;

void AacEncoder::encode(const std::int16_t* samples, std::uint32_t frames,
                        const AacFrameCallback& on_frame) {
  if (frames == 0) {
    return;
  }
  const DWORD bytes = frames * channels_ * 2;
  winrt::com_ptr<IMFMediaBuffer> buffer;
  check_encoding(MFCreateMemoryBuffer(bytes, buffer.put()), "encoding.write-failed");
  BYTE* destination = nullptr;
  check_encoding(buffer->Lock(&destination, nullptr, nullptr), "encoding.write-failed");
  std::memcpy(destination, samples, bytes);
  buffer->Unlock();
  check_encoding(buffer->SetCurrentLength(bytes), "encoding.write-failed");

  winrt::com_ptr<IMFSample> sample;
  check_encoding(MFCreateSample(sample.put()), "encoding.write-failed");
  check_encoding(sample->AddBuffer(buffer.get()), "encoding.write-failed");
  const std::int64_t time = audio_frames_to_hns(input_frames_, sample_rate_);
  check_encoding(sample->SetSampleTime(time), "encoding.write-failed");
  check_encoding(
      sample->SetSampleDuration(audio_frames_to_hns(input_frames_ + frames, sample_rate_) - time),
      "encoding.write-failed");
  input_frames_ += frames;

  HRESULT hr = transform_->ProcessInput(0, sample.get(), 0);
  if (hr == MF_E_NOTACCEPTING) {
    collect(on_frame);
    hr = transform_->ProcessInput(0, sample.get(), 0);
  }
  check_encoding(hr, "encoding.write-failed");
  collect(on_frame);
}

void AacEncoder::drain(const AacFrameCallback& on_frame) {
  check_encoding(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0),
                 "encoding.write-failed");
  check_encoding(transform_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0), "encoding.write-failed");
  collect(on_frame);
}

void AacEncoder::collect(const AacFrameCallback& on_frame) {
  for (;;) {
    winrt::com_ptr<IMFSample> sample;
    MFT_OUTPUT_DATA_BUFFER output{};
    if (!transform_allocates_output_) {
      winrt::com_ptr<IMFMediaBuffer> buffer;
      check_encoding(MFCreateMemoryBuffer(output_buffer_bytes_, buffer.put()),
                     "encoding.write-failed");
      check_encoding(MFCreateSample(sample.put()), "encoding.write-failed");
      check_encoding(sample->AddBuffer(buffer.get()), "encoding.write-failed");
      output.pSample = sample.get();
    }

    DWORD status = 0;
    const HRESULT hr = transform_->ProcessOutput(0, 1, &output, &status);
    if (output.pEvents != nullptr) {
      output.pEvents->Release();
    }
    if (transform_allocates_output_ && output.pSample != nullptr) {
      sample.attach(output.pSample);
    }
    if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
      return;
    }
    check_encoding(hr, "encoding.write-failed");
    // The encoder emits one AAC frame per output sample.
    on_frame(sample.get(), output_frames_++);
  }
}

}  // namespace usee::recorder_host
