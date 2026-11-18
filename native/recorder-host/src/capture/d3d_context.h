#pragma once

#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

namespace usee::recorder_host {

// One Direct3D 11 device shared by capture, the frame store and Media
// Foundation. It is multithread-protected because WGC callbacks, the encoder
// thread and MF's own threads all use the immediate context.
struct D3DContext {
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext> context;
  winrt::com_ptr<IMFDXGIDeviceManager> device_manager;
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice capture_device{nullptr};
  bool is_software_adapter = false;
};

// Hardware adapter first; WARP when no usable GPU exists (CI runners).
D3DContext create_d3d_context();

// A BGRA texture usable as a copy target, render target and encoder input.
winrt::com_ptr<ID3D11Texture2D> create_frame_texture(ID3D11Device* device, unsigned width,
                                                     unsigned height);

}  // namespace usee::recorder_host
