#pragma once

#include "capture/frame_source.h"

namespace usee::recorder_host {

// The largest size that fits `bounds` with `source`'s aspect ratio, rounded
// down to even dimensions for H.264. Sources that already fit keep their size.
inline FrameSize fit_within(FrameSize source, FrameSize bounds) {
  if (source.width <= bounds.width && source.height <= bounds.height) {
    return {source.width & ~1u, source.height & ~1u};
  }
  const auto even = [](std::uint64_t value) {
    return std::max(2u, static_cast<unsigned>(value) & ~1u);
  };
  // Integer arithmetic throughout: no rounding drift on exact ratios such as 4K → 1080p.
  if (std::uint64_t{source.width} * bounds.height >= std::uint64_t{bounds.width} * source.height) {
    return {even(bounds.width), even(std::uint64_t{source.height} * bounds.width / source.width)};
  }
  return {even(std::uint64_t{source.width} * bounds.height / source.height), even(bounds.height)};
}

// Downscales BGRA frames on the GPU's video engine (ID3D11VideoProcessor), so
// a large display is encoded at a size the encoder can sustain without the
// frame ever leaving the GPU.
class GpuScaler {
 public:
  GpuScaler(ID3D11Device* device, winrt::com_ptr<ID3D11DeviceContext> context, FrameSize input,
            FrameSize output, ID3D11Texture2D* output_texture);

  // Copies `box` of `source`, at most the input's size, into the scaler's
  // input, then scales it into the output texture. Both steps are queued on
  // the GPU.
  void scale(ID3D11Texture2D* source, const D3D11_BOX& box);

 private:
  winrt::com_ptr<ID3D11DeviceContext> context_;
  winrt::com_ptr<ID3D11VideoContext> video_context_;
  winrt::com_ptr<ID3D11VideoProcessor> processor_;
  winrt::com_ptr<ID3D11Texture2D> input_;
  winrt::com_ptr<ID3D11VideoProcessorInputView> input_view_;
  winrt::com_ptr<ID3D11VideoProcessorOutputView> output_view_;
};

}  // namespace usee::recorder_host
