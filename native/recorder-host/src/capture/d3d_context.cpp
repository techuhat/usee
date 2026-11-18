#include "pch.h"

#include "capture/d3d_context.h"

#include "util/host_error.h"

namespace usee::recorder_host {

namespace {

HRESULT create_device(D3D_DRIVER_TYPE driver, D3DContext& result) {
  constexpr UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
  constexpr D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
                                          D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
  return D3D11CreateDevice(nullptr, driver, nullptr, flags, levels,
                           static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
                           result.device.put(), nullptr, result.context.put());
}

}  // namespace

D3DContext create_d3d_context() {
  D3DContext result;
  HRESULT hr = create_device(D3D_DRIVER_TYPE_HARDWARE, result);
  if (FAILED(hr)) {
    result.device = nullptr;
    result.context = nullptr;
    hr = create_device(D3D_DRIVER_TYPE_WARP, result);
    result.is_software_adapter = true;
  }
  check_hr(hr, ErrorCategory::capture, "capture.device-unavailable");

  result.context.as<ID3D11Multithread>()->SetMultithreadProtected(TRUE);

  UINT reset_token = 0;
  check_hr(MFCreateDXGIDeviceManager(&reset_token, result.device_manager.put()),
           ErrorCategory::encoding, "encoding.device-manager-failed");
  check_hr(result.device_manager->ResetDevice(result.device.get(), reset_token),
           ErrorCategory::encoding, "encoding.device-manager-failed");

  const auto dxgi_device = result.device.as<IDXGIDevice>();
  winrt::com_ptr<::IInspectable> inspectable;
  check_hr(CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.get(), inspectable.put()),
           ErrorCategory::capture, "capture.device-unavailable");
  result.capture_device =
      inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
  return result;
}

winrt::com_ptr<ID3D11Texture2D> create_frame_texture(ID3D11Device* device, unsigned width,
                                                     unsigned height) {
  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

  winrt::com_ptr<ID3D11Texture2D> texture;
  check_hr(device->CreateTexture2D(&description, nullptr, texture.put()), ErrorCategory::capture,
           "capture.out-of-video-memory", true);
  return texture;
}

}  // namespace usee::recorder_host
