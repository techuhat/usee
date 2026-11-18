#pragma once

#include <cstdint>
#include <functional>

namespace usee::recorder_host {

struct FrameSize {
  unsigned width = 0;
  unsigned height = 0;
};

// A rectangle of a frame, in its pixels.
struct FrameRegion {
  unsigned x = 0;
  unsigned y = 0;
  unsigned width = 0;
  unsigned height = 0;
};

// Receives each captured frame on the source's own thread. `texture` is valid
// only for the duration of the call; `time_hns` is on the QPC timeline.
using FrameCallback =
    std::function<void(ID3D11Texture2D* texture, FrameSize content, std::int64_t time_hns)>;

// Called once if the source disappears (display unplugged, device lost).
using SourceLostCallback = std::function<void()>;

class FrameSource {
 public:
  virtual ~FrameSource() = default;
  virtual FrameSize size() const = 0;
  virtual void start() = 0;
  virtual void stop() noexcept = 0;
};

}  // namespace usee::recorder_host
