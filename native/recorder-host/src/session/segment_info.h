#pragma once

#include <cstdint>
#include <string>

#include "session/segment_naming.h"

namespace usee::recorder_host {

// One finalized segment, as the journal's `segment-closed` record lists it.
struct SegmentInfo {
  StreamKind stream = StreamKind::video;
  int index = 0;
  std::string file_name;
  // Session-relative microseconds on the shared clock.
  std::int64_t start_us = 0;
  std::int64_t duration_us = 0;
  std::uint64_t bytes = 0;
  std::string sha256;
  // Video frames or audio sample frames.
  std::int64_t frames = 0;
};

}  // namespace usee::recorder_host
