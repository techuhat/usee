#pragma once

#include <atomic>

#include <winrt/Windows.Graphics.Capture.h>

#include "capture/d3d_context.h"
#include "capture/frame_source.h"

namespace usee::recorder_host {

// Windows Graphics Capture of one monitor or one window (ADR-009). Frames
// arrive on a free-threaded frame pool, so the callback runs off any UI
// thread; it must stay short. Windows shows its capture border while
// recording; the host never bypasses it.
class DisplayCapture final : public FrameSource {
 public:
  DisplayCapture(const D3DContext& d3d, HMONITOR monitor, bool include_cursor,
                 FrameCallback on_frame, SourceLostCallback on_lost);
  // A window as Windows composes it, its frame included. Windows refuses some
  // windows (protected content); that is `capture.source-unavailable`.
  DisplayCapture(const D3DContext& d3d, HWND window, bool include_cursor, FrameCallback on_frame,
                 SourceLostCallback on_lost);
  ~DisplayCapture() override;

  FrameSize size() const override { return size_; }
  void start() override;
  void stop() noexcept override;

  static bool is_supported();

 private:
  void open(bool include_cursor);
  void on_frame_arrived(const winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool& pool);

  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice device_{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool pool_{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::FrameArrived_revoker
      frame_arrived_;
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem::Closed_revoker closed_;
  winrt::Windows::Graphics::SizeInt32 pool_size_{};
  FrameSize size_{};
  FrameCallback on_frame_;
  SourceLostCallback on_lost_;
  std::atomic<bool> stopped_{false};
};

}  // namespace usee::recorder_host
