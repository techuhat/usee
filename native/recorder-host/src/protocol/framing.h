#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace usee::recorder_host {

// Wire framing (docs/recorder-host-protocol.md): a 4-byte little-endian
// payload length, then that many bytes of UTF-8 JSON. Lengths of 0 or above
// kMaxFrameBytes are protocol violations and end the connection.
inline constexpr std::uint32_t kMaxFrameBytes = 64 * 1024;

class ProtocolViolation : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

std::string encode_frame(std::string_view payload);

// Incremental decoder for a byte stream that may split or merge frames.
class FrameDecoder {
 public:
  // Appends bytes and returns every payload completed by them.
  std::vector<std::string> push(std::string_view bytes);

  // Bytes buffered for an incomplete frame.
  size_t pending_bytes() const noexcept { return buffer_.size(); }

 private:
  std::string buffer_;
};

}  // namespace usee::recorder_host
