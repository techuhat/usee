#include "pch.h"

#include "capture/display_capture.h"

#include "util/host_error.h"

namespace usee::recorder_host {

namespace capture = winrt::Windows::Graphics::Capture;
using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;

bool DisplayCapture::is_supported() {
  try {
    return capture::GraphicsCaptureSession::IsSupported();
  } catch (...) {
    return false;
  }
}

DisplayCapture::DisplayCapture(const D3DContext& d3d, HMONITOR monitor, bool include_cursor,
                               FrameCallback on_frame, SourceLostCallback on_lost)
    : device_(d3d.capture_device), on_frame_(std::move(on_frame)), on_lost_(std::move(on_lost)) {
  const auto interop =
      winrt::get_activation_factory<capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  check_hr(interop->CreateForMonitor(monitor, winrt::guid_of<capture::IGraphicsCaptureItem>(),
                                     winrt::put_abi(item_)),
           ErrorCategory::capture, "capture.source-unavailable");
  open(include_cursor);
}

DisplayCapture::DisplayCapture(const D3DContext& d3d, HWND window, bool include_cursor,
                               FrameCallback on_frame, SourceLostCallback on_lost)
    : device_(d3d.capture_device), on_frame_(std::move(on_frame)), on_lost_(std::move(on_lost)) {
  const auto interop =
      winrt::get_activation_factory<capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  check_hr(interop->CreateForWindow(window, winrt::guid_of<capture::IGraphicsCaptureItem>(),
                                    winrt::put_abi(item_)),
           ErrorCategory::capture, "capture.source-unavailable");
  open(include_cursor);
}

void DisplayCapture::open(bool include_cursor) {
  pool_size_ = item_.Size();
  // H.264 needs even dimensions; the odd edge pixel is dropped.
  size_ = {static_cast<unsigned>(pool_size_.Width) & ~1u,
           static_cast<unsigned>(pool_size_.Height) & ~1u};
  if (size_.width == 0 || size_.height == 0) {
    throw HostError(ErrorCategory::capture, "capture.source-unavailable", false, "empty source");
  }

  pool_ = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
      device_, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, pool_size_);
  session_ = pool_.CreateCaptureSession(item_);

  if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
          L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled")) {
    session_.IsCursorCaptureEnabled(include_cursor);
  }

  frame_arrived_ = pool_.FrameArrived(
      winrt::auto_revoke,
      [this](const capture::Direct3D11CaptureFramePool& sender, const auto&) {
        on_frame_arrived(sender);
      });
  closed_ = item_.Closed(winrt::auto_revoke, [this](const auto&, const auto&) {
    if (!stopped_.exchange(true) && on_lost_) {
      on_lost_();
    }
  });
}

DisplayCapture::~DisplayCapture() { stop(); }

void DisplayCapture::start() { session_.StartCapture(); }

void DisplayCapture::stop() noexcept {
  stopped_ = true;
  try {
    frame_arrived_.revoke();
    closed_.revoke();
    if (session_) {
      session_.Close();
      session_ = nullptr;
    }
    if (pool_) {
      pool_.Close();
      pool_ = nullptr;
    }
  } catch (...) {
    // Closing a capture that Windows already tore down is harmless.
  }
}

void DisplayCapture::on_frame_arrived(const capture::Direct3D11CaptureFramePool& pool) {
  try {
    const capture::Direct3D11CaptureFrame frame = pool.TryGetNextFrame();
    if (!frame || stopped_) {
      return;
    }

    const auto content = frame.ContentSize();
    const auto access = frame.Surface()
                            .as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    winrt::com_ptr<ID3D11Texture2D> texture;
    winrt::check_hresult(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), texture.put_void()));

    on_frame_(texture.get(),
              {static_cast<unsigned>(std::max(content.Width, 0)),
               static_cast<unsigned>(std::max(content.Height, 0))},
              frame.SystemRelativeTime().count());
    frame.Close();

    // The display changed resolution: recreate the pool at the new size. The
    // encoder keeps its original size and copies the overlapping region.
    if (content.Width != pool_size_.Width || content.Height != pool_size_.Height) {
      pool_size_ = content;
      pool.Recreate(device_, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, pool_size_);
    }
  } catch (...) {
    if (!stopped_.exchange(true) && on_lost_) {
      on_lost_();
    }
  }
}

}  // namespace usee::recorder_host
