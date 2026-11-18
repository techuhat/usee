#include "pch.h"

#include "capture/gpu_scaler.h"

#include "capture/d3d_context.h"
#include "util/host_error.h"

namespace usee::recorder_host {

namespace {

void check_scaler(HRESULT hr) { check_hr(hr, ErrorCategory::capture, "capture.scaler-unavailable"); }

}  // namespace

GpuScaler::GpuScaler(ID3D11Device* device, winrt::com_ptr<ID3D11DeviceContext> context,
                     FrameSize input, FrameSize output, ID3D11Texture2D* output_texture)
    : context_(std::move(context)) {
  winrt::com_ptr<ID3D11Device> owned_device;
  owned_device.copy_from(device);
  const auto video_device = owned_device.as<ID3D11VideoDevice>();
  video_context_ = context_.as<ID3D11VideoContext>();

  D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
  content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  content.InputFrameRate = {60, 1};
  content.InputWidth = input.width;
  content.InputHeight = input.height;
  content.OutputFrameRate = {60, 1};
  content.OutputWidth = output.width;
  content.OutputHeight = output.height;
  content.Usage = D3D11_VIDEO_USAGE_OPTIMAL_QUALITY;

  winrt::com_ptr<ID3D11VideoProcessorEnumerator> enumerator;
  check_scaler(video_device->CreateVideoProcessorEnumerator(&content, enumerator.put()));
  UINT support = 0;
  check_scaler(enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &support));
  if ((support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) == 0 ||
      (support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT) == 0) {
    throw HostError(ErrorCategory::capture, "capture.scaler-unavailable", false, "BGRA unsupported");
  }
  check_scaler(video_device->CreateVideoProcessor(enumerator.get(), 0, processor_.put()));

  // Capture textures belong to the frame pool and are recycled, so frames are
  // first copied into a texture the scaler owns.
  input_ = create_frame_texture(device, input.width, input.height);
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input_view{};
  input_view.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  check_scaler(video_device->CreateVideoProcessorInputView(input_.get(), enumerator.get(),
                                                           &input_view, input_view_.put()));
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output_view{};
  output_view.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  check_scaler(video_device->CreateVideoProcessorOutputView(output_texture, enumerator.get(),
                                                            &output_view, output_view_.put()));

  const RECT source_rect{0, 0, static_cast<LONG>(input.width), static_cast<LONG>(input.height)};
  const RECT target_rect{0, 0, static_cast<LONG>(output.width), static_cast<LONG>(output.height)};
  video_context_->VideoProcessorSetStreamSourceRect(processor_.get(), 0, TRUE, &source_rect);
  video_context_->VideoProcessorSetStreamDestRect(processor_.get(), 0, TRUE, &target_rect);
  video_context_->VideoProcessorSetOutputTargetRect(processor_.get(), TRUE, &target_rect);
  video_context_->VideoProcessorSetStreamAutoProcessingMode(processor_.get(), 0, FALSE);
  // Zero-initialised colour spaces mean full-range RGB in and out: scale only.
  const D3D11_VIDEO_PROCESSOR_COLOR_SPACE rgb{};
  video_context_->VideoProcessorSetStreamColorSpace(processor_.get(), 0, &rgb);
  video_context_->VideoProcessorSetOutputColorSpace(processor_.get(), &rgb);
}

void GpuScaler::scale(ID3D11Texture2D* source, const D3D11_BOX& box) {
  context_->CopySubresourceRegion(input_.get(), 0, 0, 0, 0, source, 0, &box);

  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = input_view_.get();
  check_hr(video_context_->VideoProcessorBlt(processor_.get(), output_view_.get(), 0, 1, &stream),
           ErrorCategory::capture, "capture.scale-failed");
}

}  // namespace usee::recorder_host
