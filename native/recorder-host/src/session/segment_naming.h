#pragma once

#include <cstdio>
#include <string>
#include <string_view>

namespace usee::recorder_host {

enum class StreamKind { video, audio };

inline const char* to_string(StreamKind stream) noexcept {
  return stream == StreamKind::video ? "video" : "audio";
}

// "video-00000.mp4", "audio-00003.m4a": fixed width keeps directory order equal
// to recording order.
inline std::string segment_file_name(StreamKind stream, int ordinal) {
  char buffer[32]{};
  std::snprintf(buffer, sizeof(buffer), "%s-%05d.%s", to_string(stream), ordinal,
                stream == StreamKind::video ? "mp4" : "m4a");
  return buffer;
}

}  // namespace usee::recorder_host
