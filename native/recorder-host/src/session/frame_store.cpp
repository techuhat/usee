#include "pch.h"

#include "session/frame_store.h"

#include "capture/d3d_context.h"

namespace usee::recorder_host {

FrameStore::FrameStore(ID3D11Device* device, winrt::com_ptr<ID3D11DeviceContext> context,
                       FrameRegion kept, FrameSize output)
    : context_(std::move(context)),
      latest_(create_frame_texture(device, output.width, output.height)),
      kept_(kept) {
  if (kept.width != output.width || kept.height != output.height) {
    scaler_ = std::make_unique<GpuScaler>(device, context_, FrameSize{kept.width, kept.height},
                                          output, latest_.get());
  }
}

void FrameStore::publish(ID3D11Texture2D* source, FrameSize content, std::int64_t capture_hns) {
  std::lock_guard lock(mutex_);
  // What the frame holds of the kept rectangle: a display that changed
  // resolution may hold less of it, or none.
  D3D11_TEXTURE2D_DESC description{};
  source->GetDesc(&description);
  const UINT right = std::min({kept_.x + kept_.width, content.width, description.Width});
  const UINT bottom = std::min({kept_.y + kept_.height, content.height, description.Height});
  if (right <= kept_.x || bottom <= kept_.y) {
    return;
  }
  const D3D11_BOX box{kept_.x, kept_.y, 0, right, bottom, 1};
  if (scaler_) {
    scaler_->scale(source, box);
  } else {
    context_->CopySubresourceRegion(latest_.get(), 0, 0, 0, 0, source, 0, &box);
  }
  has_frame_ = true;
  capture_hns_ = capture_hns;
  fresh_ = true;
  ++published_;
}

std::optional<StoredFrame> FrameStore::copy_latest_to(ID3D11Texture2D* target) {
  std::lock_guard lock(mutex_);
  if (!has_frame_) {
    return std::nullopt;
  }
  context_->CopyResource(target, latest_.get());
  const StoredFrame stored{capture_hns_, fresh_};
  fresh_ = false;
  return stored;
}

}  // namespace usee::recorder_host
