#pragma once

#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include "session/segment_info.h"

namespace usee::recorder_host {

inline constexpr std::wstring_view kMergedRecordingFileName = L"recording.mp4";
inline constexpr std::wstring_view kMergedRecordingPartialFileName = L"recording.partial.mp4";

struct MergedRecording {
  // Video stream duration on the session clock.
  std::int64_t duration_us = 0;
  std::uint64_t bytes = 0;
  std::string sha256;
  std::int64_t video_frames = 0;
  bool has_audio = false;
  int segments_merged = 0;
  int segments_skipped = 0;
};

// The `segment-closed` records of a session journal in journal order. Lines
// that are not such a record (other records, a line cut off by a crash) are
// skipped. Throws HostError (`storage.session-not-found`) without a journal.
std::vector<SegmentInfo> read_journal_segments(const std::filesystem::path& journal);

// The segments a merge joins, per stream in index order.
struct MergePlan {
  std::vector<SegmentInfo> video;
  std::vector<SegmentInfo> audio;
};

// Video segments may leave gaps (frames dropped at a boundary) but never
// overlap; audio segments, cut from one AAC stream, must tile exactly. Throws
// HostError. Exposed for tests.
MergePlan plan_merge(std::vector<SegmentInfo> segments);

// Remuxes a finished session's segments into one MP4 holding the H.264 video
// and, if recorded, the AAC audio, without re-encoding. Writes
// `recording.partial.mp4` and renames it to `recording.mp4` once finalized.
// Segments whose file no longer matches its journal record (size, and SHA-256
// when `verify_hashes`) are skipped. Throws HostError.
MergedRecording merge_session_segments(const std::filesystem::path& directory, bool verify_hashes);

}  // namespace usee::recorder_host
