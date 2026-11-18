#pragma once

#include <atomic>
#include <filesystem>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "audio/audio_source.h"
#include "capture/d3d_context.h"
#include "capture/frame_source.h"
#include "encode/aac_encoder.h"
#include "encode/audio_segment_writer.h"
#include "encode/sample_pool.h"
#include "encode/video_segment_writer.h"
#include "input/pointer_events.h"
#include "input/pointer_stream_writer.h"
#include "session/capture_latency.h"
#include "session/frame_store.h"
#include "session/journal.h"
#include "session/segment_info.h"
#include "session/task_queue.h"
#include "util/host_error.h"

namespace usee::recorder_host {

struct SessionMetrics {
  std::int64_t elapsed_us = 0;
  std::uint64_t frames_captured = 0;
  std::uint64_t frames_encoded = 0;
  std::uint64_t frames_dropped = 0;
  std::uint64_t audio_frames = 0;
  std::uint64_t audio_discontinuities = 0;
};

// Called from capture, encoder, audio and worker threads; implementations must
// be thread-safe and quick.
class SessionObserver {
 public:
  virtual ~SessionObserver() = default;
  virtual void on_segment_closed(const std::string& session_id, const SegmentInfo& segment) = 0;
  virtual void on_metrics(const std::string& session_id, const SessionMetrics& metrics) = 0;
  virtual void on_stream_failed(const std::string& session_id, StreamKind stream,
                                const HostError& error) = 0;
  virtual void on_session_failed(const std::string& session_id, const HostError& error) = 0;
};

struct SessionOptions {
  std::string session_id;
  std::string display_id;
  std::filesystem::path directory;
  bool synthetic_source = false;
  // The synthetic source's size: 1280 x 720 as a display, 960 x 600 as a window.
  FrameSize synthetic_size{1280, 720};
  HMONITOR monitor = nullptr;
  // A window instead of a display (ADR-009); `window_id` names it in the journal.
  HWND window = nullptr;
  std::string window_id;
  // A region of the display, in its pixels, instead of all of it (ADR-009).
  std::optional<FrameRegion> region;
  bool include_cursor = true;
  std::int64_t fps_numerator = 60;
  std::int64_t fps_denominator = 1;
  std::optional<std::wstring> audio_endpoint;
  // The synthetic test tone instead of a microphone (tests only).
  bool synthetic_audio = false;
  // Records pointer position, clicks and cursor shape into pointer.ndjson.
  bool track_pointer = false;
  std::int64_t segment_duration_ms = 10'000;
};

struct SessionStartInfo {
  FrameSize size;
  EncoderInfo encoder;
  bool audio = false;
};

struct SessionSummary {
  std::int64_t duration_us = 0;
  std::vector<SegmentInfo> segments;
  std::uint64_t frames_captured = 0;
  std::uint64_t frames_encoded = 0;
  std::uint64_t frames_dropped = 0;
  std::uint64_t audio_discontinuities = 0;
  bool audio_failed = false;
  std::optional<HostError> failure;
};

// One recording: capture → constant-frame-rate encoder → 10-second (default)
// segments, plus optional audio from one continuous AAC encoder, cut at the
// frame nearest each video boundary, all on one QPC session clock. Segments are finalized, hashed and journaled on a
// worker thread so the real-time threads never wait on disk.
class RecordingSession {
 public:
  RecordingSession(SessionOptions options, const D3DContext& d3d, SessionObserver& observer);
  ~RecordingSession();

  RecordingSession(const RecordingSession&) = delete;
  RecordingSession& operator=(const RecordingSession&) = delete;

  // Creates the session directory and journal, opens the source, encoder and
  // microphone, then starts recording. Throws HostError and cleans up.
  SessionStartInfo start();

  // Drains and finalizes everything. Idempotent.
  SessionSummary stop();

  const std::string& id() const noexcept { return options_.session_id; }

 private:
  struct VideoSegmentState {
    std::shared_ptr<VideoSegmentWriter> writer;
    int ordinal = 0;
    std::int64_t segment = -1;
    std::int64_t origin_index = 0;
    std::int64_t last_index = -1;
    std::int64_t frames = 0;
  };

  struct AudioSegmentState {
    std::shared_ptr<AudioSegmentWriter> writer;
    int ordinal = 0;
    std::int64_t segment = -1;
    std::int64_t origin_frame = 0;
    std::int64_t frames = 0;
  };

  std::filesystem::path segment_path(StreamKind stream, int ordinal) const;
  std::unique_ptr<VideoSegmentWriter> create_video_writer(int ordinal);
  void cleanup_failed_start() noexcept;

  void encoder_loop();
  bool wait_until(HANDLE timer, std::int64_t due_hns);
  void encode_frame(std::int64_t index);
  void begin_video_segment(std::int64_t index, std::int64_t segment);
  void close_video_segment();
  void prepare_next_video_writer();
  void discard_prepared_video_writer() noexcept;
  void finalize_video_segment(const VideoSegmentState& state);

  void on_audio_packet(const std::int16_t* samples, std::uint32_t frames, std::int64_t qpc_hns,
                       bool discontinuity);
  void write_audio(const std::int16_t* samples, std::uint32_t frames);
  void write_silence(std::int64_t frames);
  void write_aac_frame(IMFSample* frame, std::int64_t index);
  std::int64_t audio_segment_start(std::int64_t segment) const;
  std::int64_t audio_segment_at(std::int64_t frame) const;
  void begin_audio_segment(std::int64_t segment, std::int64_t origin_frame);
  void close_audio_segment();
  void finalize_audio_segment(const AudioSegmentState& state);
  void fail_audio(const HostError& error) noexcept;

  void record_segment(const SegmentInfo& segment);
  void fail(const HostError& error) noexcept;
  void report_metrics(std::int64_t now_hns);

  SessionOptions options_;
  D3DContext d3d_;
  SessionObserver& observer_;

  std::unique_ptr<Journal> journal_;
  std::unique_ptr<FrameSource> source_;
  std::unique_ptr<FrameStore> frame_store_;
  winrt::com_ptr<SamplePool> pool_;
  std::unique_ptr<AudioSource> audio_source_;
  std::unique_ptr<PointerStreamWriter> pointer_writer_;
  std::unique_ptr<PointerSource> pointer_source_;

  VideoFormat video_format_;
  std::int64_t frames_per_segment_ = 600;
  std::int64_t epoch_hns_ = 0;
  std::atomic<VideoInputMode> input_mode_{VideoInputMode::gpu};

  // Encoder thread only.
  std::unique_ptr<VideoSegmentWriter> first_writer_;
  VideoSegmentState video_;
  int next_video_ordinal_ = 0;
  std::future<std::unique_ptr<VideoSegmentWriter>> prepared_video_;
  int prepared_ordinal_ = -1;

  // Audio thread only (and stop(), after that thread has joined).
  std::unique_ptr<AacEncoder> aac_;
  AudioSegmentState audio_;
  int next_audio_ordinal_ = 0;
  std::int64_t audio_position_ = -1;

  // Encoder thread only (and stop(), after that thread has joined).
  CaptureLatencyMeter capture_latency_;

  std::atomic<std::uint64_t> frames_captured_{0};
  std::atomic<std::uint64_t> frames_encoded_{0};
  std::atomic<std::uint64_t> frames_dropped_{0};
  std::atomic<std::uint64_t> audio_frames_{0};
  std::atomic<std::uint64_t> audio_discontinuities_{0};
  std::atomic<bool> audio_failed_{false};

  std::mutex state_mutex_;
  std::vector<SegmentInfo> segments_;
  std::optional<HostError> failure_;

  winrt::handle stop_event_;
  std::thread encoder_thread_;
  bool started_ = false;
  bool stopped_ = false;
  SessionSummary summary_;

  // Declared last so it is destroyed first: queued tasks may still use the
  // members above.
  TaskQueue worker_;
};

}  // namespace usee::recorder_host
