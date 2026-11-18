#pragma once

#include <filesystem>

namespace usee::recorder_host {

// One AAC (.m4a) segment: consecutive frames of the session's single AAC
// stream (encode/aac_encoder.h), muxed without re-encoding.
class AudioSegmentWriter {
 public:
  AudioSegmentWriter(const std::filesystem::path& path, IMFMediaType* aac_type);
  ~AudioSegmentWriter();

  AudioSegmentWriter(const AudioSegmentWriter&) = delete;
  AudioSegmentWriter& operator=(const AudioSegmentWriter&) = delete;

  // `time_hns` is relative to the start of this segment.
  void write(IMFSample* frame, std::int64_t time_hns, std::int64_t duration_hns);
  void finalize();

  const std::filesystem::path& path() const noexcept { return path_; }

 private:
  std::filesystem::path path_;
  winrt::com_ptr<IMFSinkWriter> writer_;
  DWORD stream_ = 0;
  bool finalized_ = false;
};

}  // namespace usee::recorder_host
