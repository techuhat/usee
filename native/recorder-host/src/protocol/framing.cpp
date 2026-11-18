#include "pch.h"

#include "protocol/framing.h"

namespace usee::recorder_host {

std::string encode_frame(std::string_view payload) {
  if (payload.empty() || payload.size() > kMaxFrameBytes) {
    throw ProtocolViolation("Frame payload must be 1 to 65536 bytes.");
  }
  const auto length = static_cast<std::uint32_t>(payload.size());
  std::string frame;
  frame.reserve(4 + payload.size());
  for (int shift = 0; shift < 32; shift += 8) {
    frame.push_back(static_cast<char>((length >> shift) & 0xFF));
  }
  frame.append(payload);
  return frame;
}

std::vector<std::string> FrameDecoder::push(std::string_view bytes) {
  buffer_.append(bytes);
  std::vector<std::string> payloads;

  size_t offset = 0;
  while (buffer_.size() - offset >= 4) {
    std::uint32_t length = 0;
    for (int index = 0; index < 4; ++index) {
      length |= static_cast<std::uint32_t>(static_cast<unsigned char>(buffer_[offset + index]))
                << (index * 8);
    }
    if (length == 0 || length > kMaxFrameBytes) {
      throw ProtocolViolation("Frame length is out of range.");
    }
    if (buffer_.size() - offset - 4 < length) {
      break;
    }
    payloads.emplace_back(buffer_, offset + 4, length);
    offset += 4 + static_cast<size_t>(length);
  }

  buffer_.erase(0, offset);
  return payloads;
}

}  // namespace usee::recorder_host
