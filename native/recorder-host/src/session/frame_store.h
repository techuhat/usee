#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <optional>

#include "capture/frame_source.h"
#include "capture/gpu_scaler.h"

namespace usee::recorder_host {

// The frame copied out for encoding: when Windows composed its picture (QPC,
// 100 ns units) and whether it arrived since the previous copy.
struct StoredFrame {
  std::int64_t capture_hns = 0;
  bool fresh = false;
};

// Holds the newest captured frame in an encoder-sized texture. Capture
// publishes at whatever rate frames arrive; the encoder samples it once per
// output tick. Only one frame is ever buffered, so memory stays bounded no
// matter how fast capture runs or how slow encoding gets.
class FrameStore {
 public:
  // Keeps `kept` of each frame, the whole frame or a region of it (ADR-009);
  // when that is larger than `output` it is scaled down on the GPU as frames
  // arrive.
  FrameStore(ID3D11Device* device, winrt::com_ptr<ID3D11DeviceContext> context, FrameRegion kept,
             FrameSize output);

  // Capture thread: stores what the kept rectangle covers of `content` of
  // `source`, scaled if needed, composed at `capture_hns`.
  void publish(ID3D11Texture2D* source, FrameSize content, std::int64_t capture_hns);

  // Encoder thread: copies the newest frame into `target`. None until the
  // first frame has arrived.
  std::optional<StoredFrame> copy_latest_to(ID3D11Texture2D* target);

  std::uint64_t frames_published() const noexcept { return published_; }

 private:
  winrt::com_ptr<ID3D11DeviceContext> context_;
  winrt::com_ptr<ID3D11Texture2D> latest_;
  std::unique_ptr<GpuScaler> scaler_;
  FrameRegion kept_;
  std::mutex mutex_;
  bool has_frame_ = false;
  std::int64_t capture_hns_ = 0;
  bool fresh_ = false;
  std::atomic<std::uint64_t> published_{0};
};

}  // namespace usee::recorder_host
