#include "pch.h"

#include "capture/synthetic_source.h"

#include "session/media_clock.h"
#include "util/host_error.h"

namespace usee::recorder_host {

SyntheticSource::SyntheticSource(const D3DContext& d3d, FrameCallback on_frame, FrameSize size)
    : device_(d3d.device), on_frame_(std::move(on_frame)), size_(size) {
  context_ = d3d.context.as<ID3D11DeviceContext1>();
  texture_ = create_frame_texture(device_.get(), size_.width, size_.height);
  check_hr(device_->CreateRenderTargetView(texture_.get(), nullptr, target_.put()),
           ErrorCategory::capture, "capture.source-unavailable");
}

SyntheticSource::~SyntheticSource() { stop(); }

void SyntheticSource::start() {
  origin_hns_ = qpc_now_hns();
  running_ = true;
  thread_ = std::thread([this] { run(); });
}

void SyntheticSource::stop() noexcept {
  running_ = false;
  if (thread_.joinable()) {
    thread_.join();
  }
}

void SyntheticSource::run() {
  constexpr std::int64_t kFrameHns = kHnsPerSecond / 60;
  constexpr std::int64_t kStepHns = kHnsPerSecond / 4;
  constexpr std::int64_t kSteps = 16;  // a lap of the box every 4 seconds
  constexpr LONG kTile = 80;           // 16 x 9 tiles
  constexpr LONG kBox = 160;

  std::vector<D3D11_RECT> tiles;
  for (LONG row = 0; row * kTile < static_cast<LONG>(size_.height); ++row) {
    for (LONG column = row % 2; column * kTile < static_cast<LONG>(size_.width); column += 2) {
      tiles.push_back({column * kTile, row * kTile, (column + 1) * kTile, (row + 1) * kTile});
    }
  }
  const float background[4] = {0.08f, 0.10f, 0.25f, 1.0f};
  const float tile[4] = {0.16f, 0.24f, 0.45f, 1.0f};
  const float box[4] = {0.95f, 0.75f, 0.2f, 1.0f};

  while (running_) {
    const std::int64_t now = qpc_now_hns();
    const std::int64_t step = (now - origin_hns_) / kStepHns % kSteps;
    const LONG left = static_cast<LONG>(step * (size_.width - kBox) / (kSteps - 1));
    const D3D11_RECT rect{left, 280, left + kBox, 280 + kBox};

    context_->ClearView(target_.get(), background, nullptr, 0);
    context_->ClearView(target_.get(), tile, tiles.data(), static_cast<UINT>(tiles.size()));
    context_->ClearView(target_.get(), box, &rect, 1);
    on_frame_(texture_.get(), size_, now);

    std::this_thread::sleep_for(std::chrono::microseconds(kFrameHns / 10));
  }
}

}  // namespace usee::recorder_host
