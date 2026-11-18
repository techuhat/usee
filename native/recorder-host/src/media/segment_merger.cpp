#include "pch.h"

#include "media/segment_merger.h"

#include "protocol/json.h"
#include "session/media_clock.h"
#include "util/host_error.h"
#include "util/sha256.h"
#include "util/utf.h"

namespace usee::recorder_host {

namespace {

constexpr LONGLONG kMaxJournalBytes = 16 * 1024 * 1024;

std::string read_journal_text(const std::filesystem::path& path) {
  const winrt::file_handle file{CreateFileW(path.c_str(), GENERIC_READ,
                                            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                            OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr)};
  if (!file) {
    const DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
      throw HostError(ErrorCategory::storage, "storage.session-not-found", false);
    }
    check_hr(HRESULT_FROM_WIN32(error), ErrorCategory::storage, "storage.read-failed");
  }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.get(), &size) || size.QuadPart > kMaxJournalBytes) {
    throw HostError(ErrorCategory::storage, "storage.journal-invalid", false);
  }
  std::string text(static_cast<size_t>(size.QuadPart), '\0');
  DWORD read = 0;
  if (!text.empty() &&
      (!ReadFile(file.get(), text.data(), static_cast<DWORD>(text.size()), &read, nullptr) ||
       read != text.size())) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::storage, "storage.read-failed");
  }
  return text;
}

std::optional<SegmentInfo> parse_segment_record(std::string_view line) {
  const auto object = json::parse_object(line);
  if (!object) {
    return std::nullopt;
  }
  try {
    if (json::require_string(*object, L"record", 32) != "segment-closed") {
      return std::nullopt;
    }
    SegmentInfo segment;
    const std::string stream = json::require_string(*object, L"stream", 8);
    if (stream != "video" && stream != "audio") {
      return std::nullopt;
    }
    segment.stream = stream == "video" ? StreamKind::video : StreamKind::audio;
    segment.index = static_cast<int>(json::require_integer(*object, L"index", 0, 99'999));
    segment.file_name = json::require_string(*object, L"fileName", 32);
    // Only the host's own naming scheme, so a record can never name another file.
    if (segment.file_name != segment_file_name(segment.stream, segment.index)) {
      return std::nullopt;
    }
    segment.start_us = json::require_integer(*object, L"startUs", 0, json::kMaxSafeInteger);
    segment.duration_us = json::require_integer(*object, L"durationUs", 0, json::kMaxSafeInteger);
    segment.bytes = static_cast<std::uint64_t>(
        json::require_integer(*object, L"bytes", 0, json::kMaxSafeInteger));
    segment.sha256 = json::require_string(*object, L"sha256", 64);
    segment.frames = json::require_integer(*object, L"frames", 0, json::kMaxSafeInteger);
    return segment;
  } catch (const json::InvalidParams&) {
    return std::nullopt;
  }
}

bool file_matches(const std::filesystem::path& path, const SegmentInfo& segment, bool verify_hash) {
  std::error_code error;
  const auto size = std::filesystem::file_size(path, error);
  if (error || size != segment.bytes) {
    return false;
  }
  try {
    return !verify_hash || hash_file(path).sha256_hex == segment.sha256;
  } catch (const HostError&) {
    return false;
  }
}

void check_write(HRESULT hr) {
  if (hr == HRESULT_FROM_WIN32(ERROR_DISK_FULL) || hr == HRESULT_FROM_WIN32(ERROR_HANDLE_DISK_FULL)) {
    throw HostError(ErrorCategory::storage, "storage.disk-full", true, format_hresult(hr));
  }
  check_hr(hr, ErrorCategory::storage, "storage.merge-failed");
}

void check_read(HRESULT hr) { check_hr(hr, ErrorCategory::storage, "storage.segment-unreadable"); }

bool same_value(IMFMediaType* first, IMFMediaType* next, const GUID& key) {
  PROPVARIANT value;
  PropVariantInit(&value);
  if (FAILED(first->GetItem(key, &value))) {
    return FAILED(next->GetItem(key, nullptr));
  }
  BOOL same = FALSE;
  const HRESULT hr = next->CompareItem(key, value, &same);
  PropVariantClear(&value);
  return SUCCEEDED(hr) && same == TRUE;
}

// What must match for two segments' samples to share one track: the codec
// configuration (H.264 SPS/PPS, AAC AudioSpecificConfig) and the frame
// layout. A mid-session switch to the software encoder can change the SPS.
bool compatible(IMFMediaType* first, IMFMediaType* next, StreamKind kind) {
  const std::vector<GUID> keys =
      kind == StreamKind::video
          ? std::vector<GUID>{MF_MT_SUBTYPE, MF_MT_FRAME_SIZE, MF_MT_MPEG_SEQUENCE_HEADER}
          : std::vector<GUID>{MF_MT_SUBTYPE, MF_MT_AUDIO_SAMPLES_PER_SECOND,
                              MF_MT_AUDIO_NUM_CHANNELS, MF_MT_USER_DATA};
  return std::all_of(keys.begin(), keys.end(),
                     [&](const GUID& key) { return same_value(first, next, key); });
}

// One stream's compressed samples across consecutive segment files, re-timed
// from each file's own zero onto the session clock.
class SegmentStream {
 public:
  SegmentStream(std::filesystem::path directory, std::vector<SegmentInfo> segments, StreamKind kind)
      : directory_(std::move(directory)), segments_(std::move(segments)), kind_(kind) {
    open(0);
  }

  IMFMediaType* media_type() const noexcept { return type_.get(); }

  // The next sample with its session time, or nullptr after the last segment.
  winrt::com_ptr<IMFSample> next(std::int64_t& time_hns) {
    while (reader_) {
      DWORD flags = 0;
      LONGLONG timestamp = 0;
      winrt::com_ptr<IMFSample> sample;
      check_read(reader_->ReadSample(selector(), 0, nullptr, &flags, &timestamp, sample.put()));
      if ((flags & MF_SOURCE_READERF_ERROR) != 0) {
        throw HostError(ErrorCategory::storage, "storage.segment-unreadable", false);
      }
      if ((flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) {
        if (current_ + 1 < segments_.size()) {
          open(current_ + 1);
        } else {
          reader_ = nullptr;
        }
        continue;
      }
      if (!sample) {
        continue;  // a stream tick
      }
      time_hns = offset_hns_ + timestamp;
      check_read(sample->SetSampleTime(time_hns));
      UINT64 decode_time = 0;
      if (SUCCEEDED(sample->GetUINT64(MFSampleExtension_DecodeTimestamp, &decode_time))) {
        check_read(sample->SetUINT64(MFSampleExtension_DecodeTimestamp,
                                     decode_time + static_cast<UINT64>(offset_hns_)));
      }
      return sample;
    }
    return nullptr;
  }

 private:
  DWORD selector() const noexcept {
    return static_cast<DWORD>(kind_ == StreamKind::video ? MF_SOURCE_READER_FIRST_VIDEO_STREAM
                                                         : MF_SOURCE_READER_FIRST_AUDIO_STREAM);
  }

  void open(size_t index) {
    reader_ = nullptr;
    const auto path = directory_ / to_wide(segments_[index].file_name);
    check_read(MFCreateSourceReaderFromURL(path.c_str(), nullptr, reader_.put()));
    check_read(reader_->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE));
    check_read(reader_->SetStreamSelection(selector(), TRUE));
    // The current type of an untouched reader is the compressed native type.
    winrt::com_ptr<IMFMediaType> type;
    check_read(reader_->GetCurrentMediaType(selector(), type.put()));
    if (!type_) {
      type_ = type;
    } else if (!compatible(type_.get(), type.get(), kind_)) {
      throw HostError(ErrorCategory::encoding, "encoding.merge-incompatible", false);
    }
    current_ = index;
    offset_hns_ = segment_offset_hns(index);
  }

  // Video segments start at their journaled time. Audio segments tile one AAC
  // stream, so their start is counted in sample frames, which keeps every
  // frame exactly where the encoder put it.
  std::int64_t segment_offset_hns(size_t index) const {
    const SegmentInfo& first = segments_.front();
    if (kind_ == StreamKind::video) {
      return segments_[index].start_us * 10;
    }
    UINT32 rate = 0;
    check_read(type_->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate));
    std::int64_t origin = first.start_us * rate / 1'000'000;
    for (size_t previous = 0; previous < index; ++previous) {
      origin += segments_[previous].frames;
    }
    return audio_frames_to_hns(origin, rate);
  }

  std::filesystem::path directory_;
  std::vector<SegmentInfo> segments_;
  StreamKind kind_;
  size_t current_ = 0;
  winrt::com_ptr<IMFSourceReader> reader_;
  winrt::com_ptr<IMFMediaType> type_;
  std::int64_t offset_hns_ = 0;
};

// Returns the number of video samples written.
std::int64_t remux(const std::filesystem::path& directory, const MergePlan& plan,
                   const std::filesystem::path& output) {
  SegmentStream video(directory, plan.video, StreamKind::video);
  std::optional<SegmentStream> audio;
  if (!plan.audio.empty()) {
    audio.emplace(directory, plan.audio, StreamKind::audio);
  }

  winrt::com_ptr<IMFAttributes> attributes;
  check_write(MFCreateAttributes(attributes.put(), 1));
  check_write(attributes->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4));
  winrt::com_ptr<IMFSinkWriter> writer;
  check_write(MFCreateSinkWriterFromURL(output.c_str(), nullptr, attributes.get(), writer.put()));

  // The same compressed type in and out: the writer only muxes.
  const auto add_stream = [&](IMFMediaType* type) {
    DWORD stream = 0;
    check_hr(writer->AddStream(type, &stream), ErrorCategory::encoding, "encoding.merge-incompatible");
    check_hr(writer->SetInputMediaType(stream, type, nullptr), ErrorCategory::encoding,
             "encoding.merge-incompatible");
    return stream;
  };
  const DWORD video_stream = add_stream(video.media_type());
  const DWORD audio_stream = audio ? add_stream(audio->media_type()) : 0;
  check_write(writer->BeginWriting());

  std::int64_t video_time = 0;
  std::int64_t audio_time = 0;
  auto video_sample = video.next(video_time);
  auto audio_sample = audio ? audio->next(audio_time) : nullptr;
  std::int64_t video_frames = 0;
  // Interleaved by time, so a player reads the file front to back.
  while (video_sample || audio_sample) {
    if (video_sample && (!audio_sample || video_time <= audio_time)) {
      check_write(writer->WriteSample(video_stream, video_sample.get()));
      ++video_frames;
      video_sample = video.next(video_time);
    } else {
      check_write(writer->WriteSample(audio_stream, audio_sample.get()));
      audio_sample = audio->next(audio_time);
    }
  }
  check_write(writer->Finalize());
  return video_frames;
}

}  // namespace

std::vector<SegmentInfo> read_journal_segments(const std::filesystem::path& journal) {
  const std::string text = read_journal_text(journal);
  std::vector<SegmentInfo> segments;
  size_t start = 0;
  while (start < text.size()) {
    const size_t end = std::min(text.find('\n', start), text.size());
    if (auto segment = parse_segment_record(std::string_view(text).substr(start, end - start))) {
      segments.push_back(std::move(*segment));
    }
    start = end + 1;
  }
  return segments;
}

MergePlan plan_merge(std::vector<SegmentInfo> segments) {
  MergePlan plan;
  for (auto& segment : segments) {
    (segment.stream == StreamKind::video ? plan.video : plan.audio).push_back(std::move(segment));
  }
  const auto by_index = [](const SegmentInfo& a, const SegmentInfo& b) { return a.index < b.index; };
  std::sort(plan.video.begin(), plan.video.end(), by_index);
  std::sort(plan.audio.begin(), plan.audio.end(), by_index);

  if (plan.video.empty()) {
    throw HostError(ErrorCategory::storage, "storage.nothing-to-merge", false);
  }
  for (size_t index = 1; index < plan.video.size(); ++index) {
    const SegmentInfo& previous = plan.video[index - 1];
    if (plan.video[index].start_us < previous.start_us + previous.duration_us) {
      throw HostError(ErrorCategory::encoding, "encoding.merge-overlap", false);
    }
  }
  for (size_t index = 1; index < plan.audio.size(); ++index) {
    const SegmentInfo& previous = plan.audio[index - 1];
    if (plan.audio[index].start_us != previous.start_us + previous.duration_us) {
      throw HostError(ErrorCategory::encoding, "encoding.merge-gap", false);
    }
  }
  return plan;
}

MergedRecording merge_session_segments(const std::filesystem::path& directory, bool verify_hashes) {
  std::vector<SegmentInfo> usable;
  int skipped = 0;
  for (auto& segment : read_journal_segments(directory / L"journal.ndjson")) {
    if (file_matches(directory / to_wide(segment.file_name), segment, verify_hashes)) {
      usable.push_back(std::move(segment));
    } else {
      ++skipped;
    }
  }
  const MergePlan plan = plan_merge(std::move(usable));

  const auto partial = directory / kMergedRecordingPartialFileName;
  const auto target = directory / kMergedRecordingFileName;
  std::error_code ignored;
  std::filesystem::remove(partial, ignored);

  MergedRecording merged;
  try {
    merged.video_frames = remux(directory, plan, partial);
  } catch (...) {
    std::filesystem::remove(partial, ignored);
    throw;
  }
  if (!MoveFileExW(partial.c_str(), target.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    const HRESULT hr = HRESULT_FROM_WIN32(GetLastError());
    std::filesystem::remove(partial, ignored);
    check_hr(hr, ErrorCategory::storage, "storage.merge-failed");
  }

  const FileDigest digest = hash_file(target);
  const SegmentInfo& last_video = plan.video.back();
  merged.duration_us = last_video.start_us + last_video.duration_us;
  merged.bytes = digest.bytes;
  merged.sha256 = digest.sha256_hex;
  merged.has_audio = !plan.audio.empty();
  merged.segments_merged = static_cast<int>(plan.video.size() + plan.audio.size());
  merged.segments_skipped = skipped;
  return merged;
}

}  // namespace usee::recorder_host
