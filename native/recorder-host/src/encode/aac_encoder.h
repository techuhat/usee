#pragma once

#include <cstdint>
#include <functional>

namespace usee::recorder_host {

// AAC-LC frames always hold 1024 PCM frames.
inline constexpr std::uint32_t kAacFrameSamples = 1024;

// Receives each encoded frame in stream order. Frame `index` starts at PCM
// frame `index * kAacFrameSamples` of the encoder's input.
using AacFrameCallback = std::function<void(IMFSample* frame, std::int64_t index)>;

// The session's one AAC-LC encoder (the Media Foundation AAC encoder MFT, 160
// kbps). Audio segments are cut between frames of this single stream, so
// joining them again is exact: no per-segment encoder priming, gap or drift.
class AacEncoder {
 public:
  AacEncoder(unsigned sample_rate, unsigned channels);
  ~AacEncoder();

  AacEncoder(const AacEncoder&) = delete;
  AacEncoder& operator=(const AacEncoder&) = delete;

  void encode(const std::int16_t* samples, std::uint32_t frames, const AacFrameCallback& on_frame);
  // Encodes whatever input the encoder still holds as the final frames.
  void drain(const AacFrameCallback& on_frame);

  // The compressed type, including its AudioSpecificConfig, for segment writers.
  IMFMediaType* output_type() const noexcept { return output_type_.get(); }

 private:
  void collect(const AacFrameCallback& on_frame);

  winrt::com_ptr<IMFTransform> transform_;
  winrt::com_ptr<IMFMediaType> output_type_;
  unsigned sample_rate_;
  unsigned channels_;
  DWORD output_buffer_bytes_ = 0;
  bool transform_allocates_output_ = false;
  std::int64_t input_frames_ = 0;
  std::int64_t output_frames_ = 0;
};

}  // namespace usee::recorder_host
