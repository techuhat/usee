#pragma once

#include <atomic>
#include <thread>

#include "capture/d3d_context.h"
#include "capture/frame_source.h"

namespace usee::recorder_host {

// A test pattern at 60 fps: a checkerboard with a box that moves a step every
// 250 ms after start(). It exercises the whole encode, segment and journal
// pipeline without touching the user's screen, so CI and automated tests never
// capture real content, and a frame shows the same picture at the same moment
// of every recording, so tests can compare frames (docs/testing.md).
class SyntheticSource final : public FrameSource {
 public:
  static constexpr unsigned kWidth = 1280;
  static constexpr unsigned kHeight = 720;

  SyntheticSource(const D3DContext& d3d, FrameCallback on_frame,
                  FrameSize size = {kWidth, kHeight});
  ~SyntheticSource() override;

  FrameSize size() const override { return size_; }
  void start() override;
  void stop() noexcept override;

 private:
  void run();

  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext1> context_;
  winrt::com_ptr<ID3D11Texture2D> texture_;
  winrt::com_ptr<ID3D11RenderTargetView> target_;
  FrameCallback on_frame_;
  FrameSize size_;
  std::int64_t origin_hns_ = 0;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

}  // namespace usee::recorder_host
