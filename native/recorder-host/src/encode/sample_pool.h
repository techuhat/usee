#pragma once

#include <mutex>
#include <optional>
#include <vector>

#include "capture/frame_source.h"

namespace usee::recorder_host {

// A fixed set of GPU textures wrapped in Media Foundation tracked samples.
// When the encoder releases a sample, MF calls Invoke and the texture returns
// to the pool. An exhausted pool means the encoder is behind: the caller drops
// that tick instead of allocating, which keeps GPU memory bounded.
class SamplePool : public winrt::implements<SamplePool, IMFAsyncCallback> {
 public:
  struct Lease {
    winrt::com_ptr<IMFSample> sample;
    ID3D11Texture2D* texture = nullptr;
  };

  SamplePool(ID3D11Device* device, FrameSize size, size_t capacity);

  std::optional<Lease> acquire();
  size_t available() const;

  // IMFAsyncCallback
  HRESULT __stdcall GetParameters(DWORD* flags, DWORD* queue) noexcept override;
  HRESULT __stdcall Invoke(IMFAsyncResult* result) noexcept override;

 private:
  struct Entry {
    winrt::com_ptr<ID3D11Texture2D> texture;
    winrt::com_ptr<IMFSample> sample;  // empty while the encoder holds it
  };

  mutable std::mutex mutex_;
  std::vector<Entry> entries_;
  std::vector<UINT32> free_;
};

}  // namespace usee::recorder_host
