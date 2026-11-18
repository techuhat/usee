#include "pch.h"

#include "session/recording_session.h"

#include "audio/microphone_capture.h"
#include "audio/synthetic_audio_source.h"
#include "capture/display_capture.h"
#include "capture/synthetic_source.h"
#include "input/display_pointer_tracker.h"
#include "input/synthetic_pointer.h"
#include "protocol/messages.h"
#include "session/media_clock.h"
#include "util/log.h"
#include "util/sha256.h"
#include "util/utf.h"

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

namespace usee::recorder_host {

namespace {

constexpr size_t kSamplePoolSize = 6;
constexpr std::int64_t kMetricsIntervalHns = 5'000'000;  // 500 ms
// A capture latency beyond this either way is not a screen's: two clocks that
// disagree, or an encoder far behind. The pointer is then read as recorded (ADR-010).
constexpr std::int64_t kMaxCaptureLatencyUs = 250'000;
constexpr std::int64_t kMaxSilencePadFrames = 5 * kAudioSampleRate;
// Phase 1 records at most 1080p: larger displays are scaled on the GPU, the
// "explicit fallback" docs/performance-budget.md asks for when the hardware
// cannot sustain native 1440p or 4K at 60 fps.
constexpr FrameSize kMaxOutputSize{1920, 1080};

json::JsonObject record(std::string_view kind) {
  json::JsonObject object;
  json::set_string(object, L"record", kind);
  return object;
}

json::JsonObject segment_record(const SegmentInfo& segment) {
  auto object = record("segment-closed");
  json::set_string(object, L"stream", to_string(segment.stream));
  json::set_int(object, L"index", segment.index);
  json::set_string(object, L"fileName", segment.file_name);
  json::set_int(object, L"startUs", segment.start_us);
  json::set_int(object, L"durationUs", segment.duration_us);
  json::set_int(object, L"bytes", static_cast<std::int64_t>(segment.bytes));
  json::set_string(object, L"sha256", segment.sha256);
  json::set_int(object, L"frames", segment.frames);
  return object;
}

/** The display's scale factor (1.0 at 96 DPI); 1.0 when Windows cannot say. */
double monitor_scale(HMONITOR monitor) noexcept {
  UINT dpi_x = 0;
  UINT dpi_y = 0;
  return SUCCEEDED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &dpi_x, &dpi_y)) && dpi_x > 0
             ? dpi_x / 96.0
             : 1.0;
}

json::JsonObject error_context(const HostError& error) {
  json::JsonObject context;
  json::set_string(context, L"code", error.code());
  if (!error.detail().empty()) {
    json::set_string(context, L"detail", error.detail());
  }
  return context;
}

}  // namespace

RecordingSession::RecordingSession(SessionOptions options, const D3DContext& d3d,
                                   SessionObserver& observer)
    : options_(std::move(options)), d3d_(d3d), observer_(observer) {
  stop_event_.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!stop_event_) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::native, "native.event-failed");
  }
}

RecordingSession::~RecordingSession() {
  try {
    stop();
  } catch (...) {
    log_event(LogLevel::error, "session.stop.failed");
  }
}

std::filesystem::path RecordingSession::segment_path(StreamKind stream, int ordinal) const {
  return options_.directory / to_wide(segment_file_name(stream, ordinal));
}

SessionStartInfo RecordingSession::start() {
  std::error_code directory_error;
  if (!std::filesystem::create_directory(options_.directory, directory_error)) {
    throw HostError(ErrorCategory::storage, "storage.session-directory-failed", false,
                    std::to_string(directory_error.value()));
  }

  try {
    journal_ = std::make_unique<Journal>(options_.directory / L"journal.ndjson");

    const auto on_frame = [this](ID3D11Texture2D* texture, FrameSize content,
                                 std::int64_t capture_hns) {
      ++frames_captured_;
      if (frame_store_) {
        frame_store_->publish(texture, content, capture_hns);
      }
    };
    const auto on_lost = [this] {
      fail(HostError(ErrorCategory::capture, "capture.source-closed", false));
    };
    if (options_.synthetic_source) {
      source_ = std::make_unique<SyntheticSource>(d3d_, on_frame, options_.synthetic_size);
    } else if (options_.window != nullptr) {
      source_ = std::make_unique<DisplayCapture>(d3d_, options_.window, options_.include_cursor,
                                                 on_frame, on_lost);
    } else {
      source_ = std::make_unique<DisplayCapture>(d3d_, options_.monitor, options_.include_cursor,
                                                 on_frame, on_lost);
    }

    const FrameSize source_size = source_->size();
    // A region keeps one rectangle of the display's frames (ADR-009).
    const FrameRegion kept =
        options_.region.value_or(FrameRegion{0, 0, source_size.width, source_size.height});
    const FrameSize capture_size{kept.width, kept.height};
    const FrameSize size = fit_within(capture_size, kMaxOutputSize);
    frame_store_ = std::make_unique<FrameStore>(d3d_.device.get(), d3d_.context, kept, size);
    pool_ = winrt::make_self<SamplePool>(d3d_.device.get(), size, kSamplePoolSize);

    video_format_.size = size;
    video_format_.fps_numerator = options_.fps_numerator;
    video_format_.fps_denominator = options_.fps_denominator;
    video_format_.bitrate = default_bitrate(size, options_.fps_numerator, options_.fps_denominator);
    video_format_.gop_frames =
        static_cast<unsigned>(std::max<std::int64_t>(1, 2 * options_.fps_numerator / options_.fps_denominator));
    frames_per_segment_ = std::max<std::int64_t>(
        1, options_.segment_duration_ms * options_.fps_numerator / (1000 * options_.fps_denominator));

    // Open the first encoder before the clock starts, so a missing encoder is
    // a start error rather than a failure mid-recording.
    first_writer_ = create_video_writer(0);
    const EncoderInfo encoder = first_writer_->encoder();

    const auto on_packet = [this](const std::int16_t* samples, std::uint32_t frames,
                                  std::int64_t qpc_hns, bool discontinuity) {
      on_audio_packet(samples, frames, qpc_hns, discontinuity);
    };
    if (options_.synthetic_audio) {
      audio_source_ = std::make_unique<SyntheticAudioSource>(on_packet);
    } else if (options_.audio_endpoint) {
      audio_source_ = std::make_unique<MicrophoneCapture>(
          *options_.audio_endpoint, on_packet, [this](const HostError& error) { fail_audio(error); });
    }
    if (audio_source_) {
      aac_ = std::make_unique<AacEncoder>(kAudioSampleRate, kAudioChannels);
    }

    epoch_hns_ = qpc_now_hns();

    if (options_.track_pointer) {
      PointerStreamHeader header;
      header.session_id = options_.session_id;
      header.display_width = capture_size.width;
      header.display_height = capture_size.height;
      // A window is drawn, and its pointer shown, at the scale of the display it is on.
      const HMONITOR monitor = options_.window != nullptr
                                   ? MonitorFromWindow(options_.window, MONITOR_DEFAULTTONEAREST)
                                   : options_.monitor;
      header.dpi_scale = options_.synthetic_source ? 1.0 : monitor_scale(monitor);
      pointer_writer_ = std::make_unique<PointerStreamWriter>(
          options_.directory / kPointerFileName, header, epoch_hns_);
      PointerEventCallback on_event = [this](const PointerEvent& event) {
        pointer_writer_->append(event);
      };
      if (options_.synthetic_source && options_.region) {
        // The synthetic pointer moves over the whole pattern; a region sees it from its corner.
        on_event = [append = on_event, kept, source_size](PointerEvent event) {
          event.x = (event.x * source_size.width - kept.x) / kept.width;
          event.y = (event.y * source_size.height - kept.y) / kept.height;
          append(event);
        };
      }
      if (options_.synthetic_source) {
        pointer_source_ = std::make_unique<SyntheticPointer>(on_event, epoch_hns_);
      } else if (options_.window != nullptr) {
        pointer_source_ = std::make_unique<DisplayPointerTracker>(options_.window, on_event);
      } else {
        pointer_source_ =
            std::make_unique<DisplayPointerTracker>(options_.monitor, on_event, options_.region);
      }
    }

    auto started = record("session-started");
    json::set_string(started, L"sessionId", options_.session_id);
    // Since protocol 1.3 the source's kind; a window by its ID, never its title.
    if (options_.window_id.empty()) {
      json::set_string(started, L"sourceKind", options_.region ? "region" : "display");
      json::set_string(started, L"displayId", options_.display_id);
      if (options_.region) {
        json::JsonObject region;
        json::set_int(region, L"x", options_.region->x);
        json::set_int(region, L"y", options_.region->y);
        json::set_int(region, L"width", options_.region->width);
        json::set_int(region, L"height", options_.region->height);
        json::set_object(started, L"region", region);
      }
    } else {
      json::set_string(started, L"sourceKind", "window");
      json::set_string(started, L"windowId", options_.window_id);
    }
    json::set_int(started, L"protocolMajor", kProtocolMajor);
    json::set_int(started, L"segmentDurationMs", options_.segment_duration_ms);
    json::JsonObject video;
    json::set_int(video, L"width", size.width);
    json::set_int(video, L"height", size.height);
    json::set_int(video, L"frameRateNumerator", options_.fps_numerator);
    json::set_int(video, L"frameRateDenominator", options_.fps_denominator);
    json::set_string(video, L"encoderName", encoder.name);
    json::set_bool(video, L"hardwareEncoder", encoder.hardware);
    json::set_object(started, L"video", video);
    if (audio_source_) {
      json::JsonObject audio;
      json::set_int(audio, L"sampleRateHz", kAudioSampleRate);
      json::set_int(audio, L"channels", kAudioChannels);
      json::set_object(started, L"audio", audio);
    } else {
      json::set_null(started, L"audio");
    }
    if (pointer_writer_) {
      json::JsonObject pointer;
      json::set_string(pointer, L"fileName", "pointer.ndjson");
      json::set_object(started, L"pointer", pointer);
    } else {
      json::set_null(started, L"pointer");
    }
    journal_->append(started);

    source_->start();
    if (audio_source_) {
      audio_source_->start();
    }
    if (pointer_source_) {
      pointer_source_->start();
    }
    encoder_thread_ = std::thread([this] { encoder_loop(); });
    started_ = true;
    return {size, encoder, audio_source_ != nullptr};
  } catch (...) {
    cleanup_failed_start();
    throw;
  }
}

void RecordingSession::cleanup_failed_start() noexcept {
  if (pointer_source_) {
    pointer_source_->stop();
    pointer_source_.reset();
  }
  pointer_writer_.reset();
  if (audio_source_) {
    audio_source_->stop();
    audio_source_.reset();
  }
  aac_.reset();
  if (source_) {
    source_->stop();
    source_.reset();
  }
  first_writer_.reset();
  journal_.reset();
  // Remove exactly the files this call created, then the (now empty) directory.
  std::error_code ignored;
  std::filesystem::remove(segment_path(StreamKind::video, 0), ignored);
  std::filesystem::remove(options_.directory / L"journal.ndjson", ignored);
  std::filesystem::remove(options_.directory / kPointerFileName, ignored);
  std::filesystem::remove(options_.directory, ignored);
}

std::unique_ptr<VideoSegmentWriter> RecordingSession::create_video_writer(int ordinal) {
  const auto path = segment_path(StreamKind::video, ordinal);
  if (input_mode_ == VideoInputMode::gpu) {
    try {
      return std::make_unique<VideoSegmentWriter>(path, video_format_, d3d_, VideoInputMode::gpu);
    } catch (const HostError& error) {
      std::error_code ignored;
      std::filesystem::remove(path, ignored);
      input_mode_ = VideoInputMode::cpu_software;
      log_event(LogLevel::warn, "session.encoder.software-fallback", error_context(error));
    }
  }
  return std::make_unique<VideoSegmentWriter>(path, video_format_, d3d_,
                                              VideoInputMode::cpu_software);
}

// --- Video ------------------------------------------------------------------

bool RecordingSession::wait_until(HANDLE timer, std::int64_t due_hns) {
  const std::int64_t delay = due_hns - qpc_now_hns();
  if (delay > 0) {
    LARGE_INTEGER due{};
    due.QuadPart = -delay;  // negative: relative, in 100 ns units
    if (SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE)) {
      const HANDLE handles[] = {stop_event_.get(), timer};
      return WaitForMultipleObjects(2, handles, FALSE, INFINITE) != WAIT_OBJECT_0;
    }
  }
  return WaitForSingleObject(stop_event_.get(), 0) != WAIT_OBJECT_0;
}

void RecordingSession::encoder_loop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  winrt::handle timer{CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                             TIMER_ALL_ACCESS)};
  if (!timer) {
    timer.attach(CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS));
  }

  const std::int64_t numerator = video_format_.fps_numerator;
  const std::int64_t denominator = video_format_.fps_denominator;
  std::int64_t index = 0;
  std::int64_t next_metrics = epoch_hns_ + kMetricsIntervalHns;

  try {
    while (wait_until(timer.get(), epoch_hns_ + frame_time_hns(index, numerator, denominator))) {
      const std::int64_t now = qpc_now_hns();
      const std::int64_t latest = frame_index_at(now - epoch_hns_, numerator, denominator);
      if (latest > index) {
        // The encoder fell behind real time; skipped ticks are dropped frames.
        if (video_.writer) {
          frames_dropped_ += static_cast<std::uint64_t>(latest - index);
        }
        index = latest;
      }
      encode_frame(index);
      ++index;
      if (now >= next_metrics) {
        report_metrics(now);
        next_metrics = now + kMetricsIntervalHns;
      }
    }
  } catch (const HostError& error) {
    fail(error);
  } catch (const winrt::hresult_error& error) {
    fail(HostError(ErrorCategory::encoding, "encoding.write-failed", false,
                   format_hresult(error.code())));
  } catch (...) {
    fail(HostError(ErrorCategory::native, "native.unexpected", false));
  }

  try {
    close_video_segment();
  } catch (...) {
    log_event(LogLevel::error, "session.video.close-failed");
  }
  discard_prepared_video_writer();
  CoUninitialize();
}

void RecordingSession::encode_frame(std::int64_t index) {
  auto lease = pool_->acquire();
  if (!lease) {
    // Every pooled texture is still inside the encoder.
    if (video_.writer) {
      ++frames_dropped_;
    }
    return;
  }
  const auto stored = frame_store_->copy_latest_to(lease->texture);
  if (!stored) {
    return;  // nothing captured yet
  }

  const std::int64_t segment = index / frames_per_segment_;
  if (!video_.writer || segment != video_.segment) {
    begin_video_segment(index, segment);
  }

  const std::int64_t numerator = video_format_.fps_numerator;
  const std::int64_t denominator = video_format_.fps_denominator;
  const std::int64_t time = frame_time_hns(index, numerator, denominator) -
                            frame_time_hns(video_.origin_index, numerator, denominator);
  const std::int64_t duration = frame_time_hns(index + 1, numerator, denominator) -
                                frame_time_hns(index, numerator, denominator);

  try {
    video_.writer->write(lease->sample.get(), lease->texture, time, duration);
  } catch (const HostError& error) {
    if (video_.frames != 0 || video_.writer->mode() != VideoInputMode::gpu) {
      throw;
    }
    // Some drivers accept the GPU input type but reject the first texture.
    // Retry this segment on the software path and keep using it.
    log_event(LogLevel::warn, "session.encoder.software-fallback", error_context(error));
    const auto path = video_.writer->path();
    video_.writer.reset();
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
    input_mode_ = VideoInputMode::cpu_software;
    discard_prepared_video_writer();
    video_.writer = create_video_writer(video_.ordinal);
    video_.writer->write(nullptr, lease->texture, time, duration);
    prepare_next_video_writer();
  }

  if (stored->fresh) {
    // A new picture: how long before its frame time Windows composed it.
    capture_latency_.add(epoch_hns_ + frame_time_hns(index, numerator, denominator) -
                         stored->capture_hns);
  }
  video_.last_index = index;
  ++video_.frames;
  ++frames_encoded_;
}

void RecordingSession::begin_video_segment(std::int64_t index, std::int64_t segment) {
  close_video_segment();

  const int ordinal = next_video_ordinal_++;
  std::unique_ptr<VideoSegmentWriter> writer;
  if (ordinal == 0 && first_writer_) {
    writer = std::move(first_writer_);
  } else if (prepared_video_.valid() && prepared_ordinal_ == ordinal) {
    try {
      writer = prepared_video_.get();
    } catch (...) {
      writer = nullptr;
    }
  }
  if (!writer || writer->mode() != input_mode_) {
    if (writer) {
      const auto path = writer->path();
      writer.reset();
      std::error_code ignored;
      std::filesystem::remove(path, ignored);
    }
    writer = create_video_writer(ordinal);
  }

  video_ = {std::shared_ptr<VideoSegmentWriter>(std::move(writer)), ordinal, segment, index, -1, 0};
  prepare_next_video_writer();
}

void RecordingSession::close_video_segment() {
  if (!video_.writer) {
    return;
  }
  VideoSegmentState state = std::move(video_);
  video_ = {};
  worker_.post([this, state] { finalize_video_segment(state); });
}

void RecordingSession::prepare_next_video_writer() {
  discard_prepared_video_writer();
  const int ordinal = next_video_ordinal_;
  auto promise = std::make_shared<std::promise<std::unique_ptr<VideoSegmentWriter>>>();
  prepared_video_ = promise->get_future();
  prepared_ordinal_ = ordinal;
  worker_.post([this, promise, ordinal] {
    try {
      promise->set_value(create_video_writer(ordinal));
    } catch (...) {
      promise->set_exception(std::current_exception());
    }
  });
}

void RecordingSession::discard_prepared_video_writer() noexcept {
  if (!prepared_video_.valid()) {
    return;
  }
  try {
    auto writer = prepared_video_.get();
    if (writer) {
      const auto path = writer->path();
      writer.reset();
      std::error_code ignored;
      std::filesystem::remove(path, ignored);
    }
  } catch (...) {
    // Preparation failed; nothing was created.
  }
  prepared_ordinal_ = -1;
}

void RecordingSession::finalize_video_segment(const VideoSegmentState& state) {
  try {
    state.writer->finalize();
    const auto digest = hash_file(state.writer->path());

    const std::int64_t numerator = video_format_.fps_numerator;
    const std::int64_t denominator = video_format_.fps_denominator;
    const std::int64_t start_hns = frame_time_hns(state.origin_index, numerator, denominator);
    const std::int64_t end_hns = frame_time_hns(state.last_index + 1, numerator, denominator);

    SegmentInfo info;
    info.stream = StreamKind::video;
    info.index = state.ordinal;
    info.file_name = segment_file_name(StreamKind::video, state.ordinal);
    // Round both ends, then subtract: start + duration then equals the next
    // segment's start exactly, so segments tile the session clock.
    info.start_us = hns_to_us(start_hns);
    info.duration_us = hns_to_us(end_hns) - info.start_us;
    info.bytes = digest.bytes;
    info.sha256 = digest.sha256_hex;
    info.frames = state.frames;
    record_segment(info);
  } catch (const HostError& error) {
    log_event(LogLevel::error, "session.segment.finalize-failed", error_context(error));
  }
}

// --- Audio ------------------------------------------------------------------

void RecordingSession::on_audio_packet(const std::int16_t* samples, std::uint32_t frames,
                                       std::int64_t qpc_hns, bool discontinuity) {
  if (audio_failed_ || frames == 0) {
    return;
  }
  try {
    const std::int64_t anchored = (qpc_hns - epoch_hns_) * kAudioSampleRate / kHnsPerSecond;
    if (audio_position_ < 0) {
      // First packet: drop any audio captured before the epoch, and start the
      // stream at the epoch with silence up to this packet, so audio and video
      // share time zero.
      std::int64_t start = anchored;
      if (start < 0) {
        const std::int64_t skip = std::min<std::int64_t>(-start, frames);
        samples += skip * kAudioChannels;
        frames -= static_cast<std::uint32_t>(skip);
        start += skip;
        if (frames == 0) {
          return;
        }
      }
      audio_position_ = 0;
      write_silence(start);
    } else if (discontinuity) {
      ++audio_discontinuities_;
      // Fill the reported gap with silence so audio stays in sync with video.
      const std::int64_t gap = anchored - audio_position_;
      if (gap > 0) {
        write_silence(std::min(gap, kMaxSilencePadFrames));
      }
    }
    write_audio(samples, frames);
  } catch (const HostError& error) {
    fail_audio(error);
  }
}

void RecordingSession::write_audio(const std::int16_t* samples, std::uint32_t frames) {
  aac_->encode(samples, frames,
               [this](IMFSample* frame, std::int64_t index) { write_aac_frame(frame, index); });
  audio_position_ += frames;
  audio_frames_ += frames;
}

void RecordingSession::write_silence(std::int64_t frames) {
  constexpr std::uint32_t kChunkFrames = kAudioSampleRate / 10;
  const std::vector<std::int16_t> silence(static_cast<size_t>(kChunkFrames) * kAudioChannels, 0);
  while (frames > 0) {
    const auto count = static_cast<std::uint32_t>(std::min<std::int64_t>(frames, kChunkFrames));
    write_audio(silence.data(), count);
    frames -= count;
  }
}

// AAC frame `index` covers PCM frames from index * 1024 on the session clock.
// It belongs to the segment its first frame falls in, so audio segments end
// on frame boundaries within one AAC frame of the video boundary.
void RecordingSession::write_aac_frame(IMFSample* frame, std::int64_t index) {
  const std::int64_t position = index * kAacFrameSamples;
  const std::int64_t segment = audio_segment_at(position);
  if (!audio_.writer || segment != audio_.segment) {
    begin_audio_segment(segment, position);
  }
  const std::int64_t offset = position - audio_.origin_frame;
  const std::int64_t time = audio_frames_to_hns(offset, kAudioSampleRate);
  const std::int64_t end = audio_frames_to_hns(offset + kAacFrameSamples, kAudioSampleRate);
  audio_.writer->write(frame, time, end - time);
  audio_.frames += kAacFrameSamples;
}

std::int64_t RecordingSession::audio_segment_start(std::int64_t segment) const {
  const std::int64_t hns = frame_time_hns(segment * frames_per_segment_, video_format_.fps_numerator,
                                          video_format_.fps_denominator);
  return hns * kAudioSampleRate / kHnsPerSecond;
}

std::int64_t RecordingSession::audio_segment_at(std::int64_t frame) const {
  const std::int64_t hns = frame * kHnsPerSecond / kAudioSampleRate;
  std::int64_t segment =
      frame_index_at(hns, video_format_.fps_numerator, video_format_.fps_denominator) /
      frames_per_segment_;
  while (segment > 0 && audio_segment_start(segment) > frame) {
    --segment;
  }
  while (audio_segment_start(segment + 1) <= frame) {
    ++segment;
  }
  return segment;
}

void RecordingSession::begin_audio_segment(std::int64_t segment, std::int64_t origin_frame) {
  close_audio_segment();
  const int ordinal = next_audio_ordinal_++;
  audio_ = {std::make_shared<AudioSegmentWriter>(segment_path(StreamKind::audio, ordinal),
                                                 aac_->output_type()),
            ordinal, segment, origin_frame, 0};
}

void RecordingSession::close_audio_segment() {
  if (!audio_.writer) {
    return;
  }
  AudioSegmentState state = std::move(audio_);
  audio_ = {};
  worker_.post([this, state] { finalize_audio_segment(state); });
}

void RecordingSession::finalize_audio_segment(const AudioSegmentState& state) {
  try {
    state.writer->finalize();
    const auto digest = hash_file(state.writer->path());

    SegmentInfo info;
    info.stream = StreamKind::audio;
    info.index = state.ordinal;
    info.file_name = segment_file_name(StreamKind::audio, state.ordinal);
    info.start_us = state.origin_frame * 1'000'000 / kAudioSampleRate;
    info.duration_us =
        (state.origin_frame + state.frames) * 1'000'000 / kAudioSampleRate - info.start_us;
    info.bytes = digest.bytes;
    info.sha256 = digest.sha256_hex;
    info.frames = state.frames;
    record_segment(info);
  } catch (const HostError& error) {
    log_event(LogLevel::error, "session.segment.finalize-failed", error_context(error));
  }
}

void RecordingSession::fail_audio(const HostError& error) noexcept {
  if (audio_failed_.exchange(true)) {
    return;
  }
  log_event(LogLevel::warn, "session.audio.failed", error_context(error));
  try {
    auto failed = record("stream-failed");
    json::set_string(failed, L"stream", "audio");
    json::set_string(failed, L"code", error.code());
    journal_->append(failed);
  } catch (...) {
  }
  observer_.on_stream_failed(options_.session_id, StreamKind::audio, error);
}

// --- Shared -----------------------------------------------------------------

void RecordingSession::record_segment(const SegmentInfo& segment) {
  {
    std::lock_guard lock(state_mutex_);
    segments_.push_back(segment);
  }
  journal_->append(segment_record(segment));
  observer_.on_segment_closed(options_.session_id, segment);
}

void RecordingSession::fail(const HostError& error) noexcept {
  {
    std::lock_guard lock(state_mutex_);
    if (failure_) {
      return;
    }
    failure_ = error;
  }
  SetEvent(stop_event_.get());
  log_event(LogLevel::error, "session.failed", error_context(error));
  try {
    auto failed = record("session-failed");
    json::set_string(failed, L"code", error.code());
    journal_->append(failed);
  } catch (...) {
  }
  observer_.on_session_failed(options_.session_id, error);
}

void RecordingSession::report_metrics(std::int64_t now_hns) {
  SessionMetrics metrics;
  metrics.elapsed_us = hns_to_us(now_hns - epoch_hns_);
  metrics.frames_captured = frames_captured_;
  metrics.frames_encoded = frames_encoded_;
  metrics.frames_dropped = frames_dropped_;
  metrics.audio_frames = audio_frames_;
  metrics.audio_discontinuities = audio_discontinuities_;
  observer_.on_metrics(options_.session_id, metrics);
}

SessionSummary RecordingSession::stop() {
  if (!started_ || stopped_) {
    return summary_;
  }
  stopped_ = true;

  SetEvent(stop_event_.get());
  source_->stop();
  if (pointer_source_) {
    pointer_source_->stop();
  }
  if (pointer_writer_) {
    pointer_writer_->close();
  }
  if (encoder_thread_.joinable()) {
    encoder_thread_.join();
  }
  if (audio_source_) {
    audio_source_->stop();
  }
  try {
    if (aac_) {
      aac_->drain([this](IMFSample* frame, std::int64_t index) { write_aac_frame(frame, index); });
    }
    close_audio_segment();
  } catch (...) {
    log_event(LogLevel::error, "session.audio.close-failed");
  }
  worker_.drain();

  {
    std::lock_guard lock(state_mutex_);
    summary_.segments = segments_;
    summary_.failure = failure_;
  }
  for (const auto& segment : summary_.segments) {
    summary_.duration_us = std::max(summary_.duration_us, segment.start_us + segment.duration_us);
  }
  summary_.frames_captured = frames_captured_;
  summary_.frames_encoded = frames_encoded_;
  summary_.frames_dropped = frames_dropped_;
  summary_.audio_discontinuities = audio_discontinuities_;
  summary_.audio_failed = audio_failed_;

  auto finalized = record("session-finalized");
  json::set_int(finalized, L"durationUs", summary_.duration_us);
  json::set_int(finalized, L"framesEncoded", static_cast<std::int64_t>(summary_.frames_encoded));
  json::set_int(finalized, L"framesDropped", static_cast<std::int64_t>(summary_.frames_dropped));
  json::set_int(finalized, L"segments", static_cast<std::int64_t>(summary_.segments.size()));
  // Since protocol 1.3: what the editor shifts the pointer by to meet the picture.
  if (const auto latency = capture_latency_.median_us();
      latency && *latency >= -kMaxCaptureLatencyUs && *latency <= kMaxCaptureLatencyUs) {
    json::set_int(finalized, L"captureLatencyUs", *latency);
  } else if (latency) {
    json::JsonObject context;
    json::set_int(context, L"captureLatencyUs", *latency);
    log_event(LogLevel::warn, "session.capture-latency.implausible", context);
  }
  // How the latency was spread, for support: numbers only, never a picture.
  if (capture_latency_.samples() > 0) {
    json::JsonObject spread;
    json::set_int(spread, L"samples", static_cast<std::int64_t>(capture_latency_.samples()));
    json::set_int(spread, L"newer", static_cast<std::int64_t>(capture_latency_.newer()));
    json::set_int(spread, L"youngestUs", capture_latency_.youngest_us());
    json::set_int(spread, L"p10Us", capture_latency_.percentile_us(0.1).value_or(0));
    json::set_int(spread, L"medianUs", capture_latency_.median_us().value_or(0));
    json::set_int(spread, L"p90Us", capture_latency_.percentile_us(0.9).value_or(0));
    log_event(LogLevel::info, "session.capture-latency", spread);
  }
  journal_->append(finalized);
  return summary_;
}

}  // namespace usee::recorder_host
