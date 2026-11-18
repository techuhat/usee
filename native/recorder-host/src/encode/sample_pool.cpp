#include "pch.h"

#include "encode/sample_pool.h"

#include "capture/d3d_context.h"
#include "util/host_error.h"

namespace usee::recorder_host {

namespace {

// {5C3D8E1A-6B0F-4C61-9C55-7B8E4E2B9A01}: pool slot stored on each sample.
constexpr GUID kPoolSlot = {0x5c3d8e1a, 0x6b0f, 0x4c61, {0x9c, 0x55, 0x7b, 0x8e, 0x4e, 0x2b, 0x9a, 0x01}};

}  // namespace

SamplePool::SamplePool(ID3D11Device* device, FrameSize size, size_t capacity) {
  entries_.reserve(capacity);
  for (UINT32 slot = 0; slot < capacity; ++slot) {
    Entry entry;
    entry.texture = create_frame_texture(device, size.width, size.height);

    winrt::com_ptr<IMFMediaBuffer> buffer;
    check_hr(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), entry.texture.get(), 0, FALSE,
                                       buffer.put()),
             ErrorCategory::encoding, "encoding.sample-allocation-failed");
    DWORD length = 0;
    check_hr(buffer.as<IMF2DBuffer>()->GetContiguousLength(&length), ErrorCategory::encoding,
             "encoding.sample-allocation-failed");
    check_hr(buffer->SetCurrentLength(length), ErrorCategory::encoding,
             "encoding.sample-allocation-failed");

    winrt::com_ptr<IMFTrackedSample> tracked;
    check_hr(MFCreateTrackedSample(tracked.put()), ErrorCategory::encoding,
             "encoding.sample-allocation-failed");
    entry.sample = tracked.as<IMFSample>();
    check_hr(entry.sample->AddBuffer(buffer.get()), ErrorCategory::encoding,
             "encoding.sample-allocation-failed");
    check_hr(entry.sample->SetUINT32(kPoolSlot, slot), ErrorCategory::encoding,
             "encoding.sample-allocation-failed");

    entries_.push_back(std::move(entry));
    free_.push_back(slot);
  }
}

std::optional<SamplePool::Lease> SamplePool::acquire() {
  std::lock_guard lock(mutex_);
  if (free_.empty()) {
    return std::nullopt;
  }
  const UINT32 slot = free_.back();
  free_.pop_back();

  Entry& entry = entries_[slot];
  // The pool gives up its reference so the encoder's release triggers Invoke.
  Lease lease{std::move(entry.sample), entry.texture.get()};
  if (FAILED(lease.sample.as<IMFTrackedSample>()->SetAllocator(this, nullptr))) {
    entry.sample = std::move(lease.sample);
    free_.push_back(slot);
    return std::nullopt;
  }
  return lease;
}

size_t SamplePool::available() const {
  std::lock_guard lock(mutex_);
  return free_.size();
}

HRESULT __stdcall SamplePool::GetParameters(DWORD*, DWORD*) noexcept { return E_NOTIMPL; }

HRESULT __stdcall SamplePool::Invoke(IMFAsyncResult* result) noexcept {
  winrt::com_ptr<IUnknown> object;
  if (result == nullptr || FAILED(result->GetObject(object.put()))) {
    return S_OK;
  }
  auto sample = object.try_as<IMFSample>();
  UINT32 slot = 0;
  if (!sample || FAILED(sample->GetUINT32(kPoolSlot, &slot))) {
    return S_OK;
  }

  // The encoder released its last reference: the texture is free to reuse.
  std::lock_guard lock(mutex_);
  if (slot < entries_.size() && !entries_[slot].sample) {
    entries_[slot].sample = std::move(sample);
    free_.push_back(slot);
  }
  return S_OK;
}

}  // namespace usee::recorder_host
