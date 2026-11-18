#include "pch.h"

#include "host_server.h"

#include "audio/microphone_capture.h"
#include "audio/synthetic_audio_source.h"
#include "capture/display_capture.h"
#include "capture/displays.h"
#include "capture/synthetic_source.h"
#include "capture/windows.h"
#include "ipc/named_pipe_server.h"
#include "media/segment_merger.h"
#include "media/waveform.h"
#include "protocol/framing.h"
#include "util/log.h"
#include "util/utf.h"

namespace usee::recorder_host {

namespace {

constexpr std::string_view kSyntheticDisplayId = "synthetic-0";
// The synthetic pattern through the window path, at a window's size (tests only).
constexpr std::string_view kSyntheticWindowId = "window-synthetic";
constexpr FrameSize kSyntheticWindowSize{960, 600};
// The most windows a list offers: with titles of at most 128 UTF-16 units
// (picker_title), even a list of escaped titles stays under the 64 KiB frame.
constexpr unsigned kMaxListedWindows = 64;
// A region's sides, in display pixels.
constexpr std::int64_t kMinRegionSide = 64;
constexpr std::int64_t kMaxRegionSide = 16'384;
constexpr auto kAcceptTimeout = std::chrono::seconds(30);

// A region must lie wholly inside its display.
void require_inside(const std::optional<FrameRegion>& region, FrameSize display) {
  if (region && (std::uint64_t{region->x} + region->width > display.width ||
                 std::uint64_t{region->y} + region->height > display.height)) {
    throw json::InvalidParams("Parameter \"region\" does not lie inside the display.");
  }
}

json::JsonObject error_object(const HostError& error) {
  json::JsonObject object;
  json::set_string(object, L"category", to_string(error.category()));
  json::set_string(object, L"code", error.code());
  json::set_bool(object, L"retryable", error.retryable());
  return object;
}

json::JsonObject segment_object(const SegmentInfo& segment) {
  json::JsonObject object;
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

json::JsonObject display_object(std::string_view id, std::string_view name, const RECT& bounds,
                                bool is_primary, int refresh_rate_hz) {
  json::JsonObject object;
  json::set_string(object, L"id", id);
  json::set_string(object, L"name", name);
  json::set_int(object, L"x", bounds.left);
  json::set_int(object, L"y", bounds.top);
  json::set_int(object, L"width", bounds.right - bounds.left);
  json::set_int(object, L"height", bounds.bottom - bounds.top);
  json::set_bool(object, L"isPrimary", is_primary);
  json::set_int(object, L"refreshRateHz", refresh_rate_hz);
  return object;
}

}  // namespace

HostServer::HostServer(HostConfig config) : config_(std::move(config)) {}

HostServer::~HostServer() { stop_active_session(); }

const D3DContext& HostServer::d3d() {
  if (!d3d_) {
    d3d_ = create_d3d_context();
    json::JsonObject context;
    json::set_bool(context, L"softwareAdapter", d3d_->is_software_adapter);
    log_event(LogLevel::info, "host.d3d.ready", context);
  }
  return *d3d_;
}

int HostServer::run() {
  pipe_ = std::make_unique<NamedPipeServer>(config_.pipe_name);
  log_event(LogLevel::info, "host.listening");

  if (!pipe_->accept(std::chrono::duration_cast<std::chrono::milliseconds>(kAcceptTimeout))) {
    log_event(LogLevel::error, "host.client.timeout");
    return 3;
  }
  // Defence in depth beside the token: only the process that launched us may connect.
  const unsigned long parent = parent_process_id();
  if (parent != 0 && pipe_->client_process_id() != parent) {
    log_event(LogLevel::error, "host.client.rejected");
    return 4;
  }
  log_event(LogLevel::info, "host.client.connected");

  FrameDecoder decoder;
  while (!closing_) {
    const auto bytes = pipe_->read();
    if (!bytes) {
      log_event(LogLevel::info, "host.client.disconnected");
      break;
    }
    try {
      for (const std::string& payload : decoder.push(*bytes)) {
        const Request request = parse_request(payload);
        if (!authenticated_ && request.method != "hello") {
          throw ProtocolViolation("The first request must be hello.");
        }
        dispatch(request);
        if (closing_) {
          break;
        }
      }
    } catch (const ProtocolViolation&) {
      log_event(LogLevel::error, "host.protocol.violation");
      break;
    }
  }

  stop_active_session();
  return 0;
}

void HostServer::dispatch(const Request& request) {
  try {
    json::JsonObject result;
    if (request.method == "hello") {
      result = handle_hello(request.params);
    } else if (request.method == "listDisplays") {
      result = handle_list_displays();
    } else if (request.method == "listWindows") {
      result = handle_list_windows();
    } else if (request.method == "listAudioInputs") {
      result = handle_list_audio_inputs();
    } else if (request.method == "startSession") {
      result = handle_start_session(request.params);
    } else if (request.method == "stopSession") {
      result = handle_stop_session(request.params);
    } else if (request.method == "mergeSession") {
      result = handle_merge_session(request.params);
    } else if (request.method == "shutdown") {
      stop_active_session();
      closing_ = true;
    } else {
      throw HostError(ErrorCategory::native, "native.unknown-method", false);
    }
    send(make_ok_response(request.id, result));
  } catch (const json::InvalidParams& error) {
    send(make_error_response(request.id, HostError(ErrorCategory::native, "native.invalid-params",
                                                   false, error.what())));
  } catch (const HostError& error) {
    send(make_error_response(request.id, error));
  } catch (const winrt::hresult_error& error) {
    send(make_error_response(request.id, HostError(ErrorCategory::native, "native.unexpected",
                                                   false, format_hresult(error.code()))));
  } catch (const std::exception&) {
    send(make_error_response(request.id,
                             HostError(ErrorCategory::native, "native.unexpected", false)));
  }
}

json::JsonObject HostServer::handle_hello(const json::JsonObject& params) {
  if (authenticated_) {
    throw HostError(ErrorCategory::native, "native.already-authenticated", false);
  }
  const auto major = json::require_integer(params, L"protocolMajor", 0, 1000);
  json::require_integer(params, L"protocolMinor", 0, 1000);
  const std::string token = json::require_string(params, L"token", 128);

  if (!tokens_equal(config_.token, token)) {
    log_event(LogLevel::error, "host.client.unauthorized");
    closing_ = true;
    throw HostError(ErrorCategory::native, "native.unauthorized", false);
  }
  if (major != kProtocolMajor) {
    closing_ = true;
    throw HostError(ErrorCategory::native, "native.protocol-mismatch", false);
  }
  authenticated_ = true;

  json::JsonObject capabilities;
  json::set_bool(capabilities, L"displayCapture", DisplayCapture::is_supported());
  json::set_bool(capabilities, L"microphone", true);
  json::set_bool(capabilities, L"syntheticSource", config_.synthetic_source_enabled);

  json::JsonObject result;
  json::set_int(result, L"protocolMajor", kProtocolMajor);
  json::set_int(result, L"protocolMinor", kProtocolMinor);
  json::set_string(result, L"hostVersion", kHostVersion);
  json::set_object(result, L"capabilities", capabilities);
  return result;
}

json::JsonObject HostServer::handle_list_displays() {
  json::JsonArray displays;
  for (const auto& display : enumerate_displays()) {
    displays.Append(display_object(display.id, display.name, display.bounds, display.is_primary,
                                   display.refresh_rate_hz));
  }
  if (config_.synthetic_source_enabled) {
    const RECT bounds{0, 0, static_cast<LONG>(SyntheticSource::kWidth),
                      static_cast<LONG>(SyntheticSource::kHeight)};
    displays.Append(display_object(kSyntheticDisplayId, "Synthetic test pattern", bounds, false, 60));
  }
  json::JsonObject result;
  json::set_array(result, L"displays", displays);
  return result;
}

json::JsonObject HostServer::handle_list_windows() {
  json::JsonArray windows;
  const auto append = [&windows](std::string_view id, std::string_view title, unsigned width,
                                 unsigned height) {
    json::JsonObject object;
    json::set_string(object, L"id", id);
    json::set_string(object, L"title", title);
    json::set_int(object, L"width", width);
    json::set_int(object, L"height", height);
    windows.Append(object);
  };
  // The synthetic window first, so the cap never drops it.
  if (config_.synthetic_source_enabled) {
    append(kSyntheticWindowId, "Synthetic test window", kSyntheticWindowSize.width,
           kSyntheticWindowSize.height);
  }
  for (const auto& window : enumerate_windows(parent_process_id())) {
    if (windows.Size() >= kMaxListedWindows) {
      break;
    }
    append(window.id, window.title, window.width, window.height);
  }
  json::JsonObject result;
  json::set_array(result, L"windows", windows);
  return result;
}

json::JsonObject HostServer::handle_list_audio_inputs() {
  json::JsonArray inputs;
  for (const auto& input : enumerate_audio_inputs()) {
    json::JsonObject object;
    json::set_string(object, L"id", input.id);
    json::set_string(object, L"name", input.name);
    json::set_bool(object, L"isDefault", input.is_default);
    inputs.Append(object);
  }
  if (config_.synthetic_source_enabled) {
    json::JsonObject object;
    json::set_string(object, L"id", SyntheticAudioSource::kInputId);
    json::set_string(object, L"name", "Synthetic test tone");
    json::set_bool(object, L"isDefault", false);
    inputs.Append(object);
  }
  json::JsonObject result;
  json::set_array(result, L"inputs", inputs);
  return result;
}

json::JsonObject HostServer::handle_start_session(const json::JsonObject& params) {
  if (session_) {
    throw HostError(ErrorCategory::capture, "capture.session-active", false);
  }

  SessionOptions options;
  options.session_id = json::require_string(params, L"sessionId", 64);
  if (!is_opaque_id(options.session_id)) {
    throw json::InvalidParams("Parameter \"sessionId\" is not an opaque identifier.");
  }
  // Since 1.3: a window or a region of a display instead of a display (ADR-009).
  const std::string source_kind =
      json::optional_string(params, L"sourceKind", 16).value_or("display");
  if (source_kind != "display" && source_kind != "window" && source_kind != "region") {
    throw json::InvalidParams("Parameter \"sourceKind\" names no known source.");
  }
  const std::string display_id =
      source_kind != "window" ? json::require_string(params, L"displayId", 64) : std::string();
  options.display_id = display_id;
  if (source_kind == "region") {
    const auto region = json::require_object(params, L"region");
    const auto side = [&region](std::wstring_view key, std::int64_t min) {
      return static_cast<unsigned>(json::require_integer(region, key, min, kMaxRegionSide));
    };
    options.region = FrameRegion{side(L"x", 0), side(L"y", 0), side(L"width", kMinRegionSide),
                               side(L"height", kMinRegionSide)};
  }
  options.fps_numerator = json::require_integer(params, L"frameRateNumerator", 1, 240'000);
  options.fps_denominator = json::require_integer(params, L"frameRateDenominator", 1, 1001);
  const double fps = static_cast<double>(options.fps_numerator) / options.fps_denominator;
  if (fps < 1.0 || fps > 120.0) {
    throw json::InvalidParams("Frame rate must be between 1 and 120 fps.");
  }
  options.include_cursor = json::require_bool(params, L"includeCursor");
  options.track_pointer = json::require_bool(params, L"trackPointer");
  options.segment_duration_ms = json::require_integer(params, L"segmentDurationMs", 2'000, 60'000);
  const auto audio_input_id = json::optional_string(params, L"audioInputId", 64);

  if (source_kind == "window") {
    options.window_id = json::require_string(params, L"windowId", 64);
    if (options.window_id == kSyntheticWindowId && config_.synthetic_source_enabled) {
      options.synthetic_source = true;
      options.synthetic_size = kSyntheticWindowSize;
    } else {
      // Found again by its ID: one that closed, hid or minimized since is refused.
      const auto windows = enumerate_windows(parent_process_id());
      const auto match = std::find_if(windows.begin(), windows.end(), [&](const WindowInfo& window) {
        return window.id == options.window_id;
      });
      if (match == windows.end()) {
        throw HostError(ErrorCategory::capture, "capture.source-unavailable", true);
      }
      options.window = match->hwnd;
    }
  } else if (display_id == kSyntheticDisplayId && config_.synthetic_source_enabled) {
    options.synthetic_source = true;
    require_inside(options.region, FrameSize{SyntheticSource::kWidth, SyntheticSource::kHeight});
  } else {
    const auto displays = enumerate_displays();
    const auto match = std::find_if(displays.begin(), displays.end(),
                                    [&](const DisplayInfo& display) { return display.id == display_id; });
    if (match == displays.end()) {
      throw HostError(ErrorCategory::capture, "capture.source-unavailable", true);
    }
    options.monitor = match->monitor;
    require_inside(options.region,
                   FrameSize{static_cast<unsigned>(match->bounds.right - match->bounds.left),
                             static_cast<unsigned>(match->bounds.bottom - match->bounds.top)});
  }

  if (audio_input_id && *audio_input_id == SyntheticAudioSource::kInputId &&
      config_.synthetic_source_enabled) {
    options.synthetic_audio = true;
  } else if (audio_input_id) {
    const auto inputs = enumerate_audio_inputs();
    const auto match = std::find_if(inputs.begin(), inputs.end(),
                                    [&](const AudioInputInfo& input) { return input.id == *audio_input_id; });
    if (match == inputs.end()) {
      throw HostError(ErrorCategory::audio, "audio.device-unavailable", true);
    }
    options.audio_endpoint = match->endpoint_id;
  }

  try {
    options.directory = session_directory(config_.staging_root, options.session_id);
  } catch (const std::invalid_argument& error) {
    throw json::InvalidParams(error.what());
  }

  const std::string session_id = options.session_id;
  auto session = std::make_unique<RecordingSession>(std::move(options), d3d(), *this);
  const SessionStartInfo started = session->start();
  session_ = std::move(session);

  json::JsonObject video;
  json::set_int(video, L"width", started.size.width);
  json::set_int(video, L"height", started.size.height);
  json::set_string(video, L"encoderName", started.encoder.name);
  json::set_bool(video, L"hardwareEncoder", started.encoder.hardware);

  json::JsonObject result;
  json::set_string(result, L"sessionId", session_id);
  json::set_object(result, L"video", video);
  if (started.audio) {
    json::JsonObject audio;
    json::set_int(audio, L"sampleRateHz", kAudioSampleRate);
    json::set_int(audio, L"channels", kAudioChannels);
    json::set_object(result, L"audio", audio);
  } else {
    json::set_null(result, L"audio");
  }

  json::JsonObject context;
  json::set_int(context, L"width", started.size.width);
  json::set_int(context, L"height", started.size.height);
  json::set_bool(context, L"hardwareEncoder", started.encoder.hardware);
  json::set_bool(context, L"audio", started.audio);
  log_event(LogLevel::info, "session.started", context);
  emit_state(session_id, "recording");
  return result;
}

json::JsonObject HostServer::handle_stop_session(const json::JsonObject& params) {
  const std::string session_id = json::require_string(params, L"sessionId", 64);
  if (!session_ || session_->id() != session_id) {
    throw HostError(ErrorCategory::capture, "capture.session-not-found", false);
  }

  emit_state(session_id, "finalizing");
  const SessionSummary summary = session_->stop();
  session_.reset();

  json::JsonArray segments;
  for (const auto& segment : summary.segments) {
    segments.Append(segment_object(segment));
  }
  json::JsonObject result;
  json::set_string(result, L"sessionId", session_id);
  json::set_int(result, L"durationUs", summary.duration_us);
  json::set_int(result, L"framesCaptured", static_cast<std::int64_t>(summary.frames_captured));
  json::set_int(result, L"framesEncoded", static_cast<std::int64_t>(summary.frames_encoded));
  json::set_int(result, L"framesDropped", static_cast<std::int64_t>(summary.frames_dropped));
  json::set_int(result, L"audioDiscontinuities",
                static_cast<std::int64_t>(summary.audio_discontinuities));
  json::set_bool(result, L"audioFailed", summary.audio_failed);
  json::set_array(result, L"segments", segments);
  if (summary.failure) {
    json::set_object(result, L"failure", error_object(*summary.failure));
  } else {
    json::set_null(result, L"failure");
  }

  json::JsonObject context;
  json::set_int(context, L"durationUs", summary.duration_us);
  json::set_int(context, L"framesEncoded", static_cast<std::int64_t>(summary.frames_encoded));
  json::set_int(context, L"framesDropped", static_cast<std::int64_t>(summary.frames_dropped));
  json::set_int(context, L"segments", static_cast<std::int64_t>(summary.segments.size()));
  log_event(LogLevel::info, "session.finalized", context);
  emit_state(session_id, summary.failure ? "failed" : "completed",
             summary.failure ? &*summary.failure : nullptr);
  return result;
}

json::JsonObject HostServer::handle_merge_session(const json::JsonObject& params) {
  const std::string session_id = json::require_string(params, L"sessionId", 64);
  const bool verify_hashes = json::require_bool(params, L"verifyHashes");
  if (session_ && session_->id() == session_id) {
    throw HostError(ErrorCategory::capture, "capture.session-active", false);
  }
  std::filesystem::path directory;
  try {
    directory = session_directory(config_.staging_root, session_id);
  } catch (const std::invalid_argument& error) {
    throw json::InvalidParams(error.what());
  }

  const auto started = std::chrono::steady_clock::now();
  MergedRecording merged;
  try {
    merged = merge_session_segments(directory, verify_hashes);
  } catch (const HostError& error) {
    // Main falls back to importing the segments; this records why.
    json::JsonObject context;
    json::set_string(context, L"code", error.code());
    log_event(LogLevel::warn, "session.merge.failed", context);
    throw;
  }

  json::JsonObject result;
  json::set_string(result, L"sessionId", session_id);
  json::set_string(result, L"fileName", to_utf8(kMergedRecordingFileName));
  json::set_int(result, L"durationUs", merged.duration_us);
  json::set_int(result, L"bytes", static_cast<std::int64_t>(merged.bytes));
  json::set_string(result, L"sha256", merged.sha256);
  json::set_int(result, L"videoFrames", merged.video_frames);
  json::set_bool(result, L"hasAudio", merged.has_audio);
  json::set_int(result, L"segmentsMerged", merged.segments_merged);
  json::set_int(result, L"segmentsSkipped", merged.segments_skipped);

  // The waveform is derived and optional: without it the editor shows no peaks.
  json::set_null(result, L"waveform");
  if (merged.has_audio) {
    try {
      const WaveformInfo waveform =
          write_waveform(directory / kMergedRecordingFileName, merged.sha256);
      json::JsonObject object;
      json::set_string(object, L"fileName", to_utf8(kWaveformFileName));
      json::set_int(object, L"peaksPerSecond", waveform.peaks_per_second);
      json::set_int(object, L"peakCount", waveform.peak_count);
      json::set_object(result, L"waveform", object);
    } catch (const HostError& error) {
      json::JsonObject context;
      json::set_string(context, L"code", error.code());
      log_event(LogLevel::warn, "session.waveform.failed", context);
    }
  }

  json::JsonObject context;
  json::set_int(context, L"durationMs",
                std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - started)
                    .count());
  json::set_int(context, L"segmentsMerged", merged.segments_merged);
  json::set_int(context, L"segmentsSkipped", merged.segments_skipped);
  json::set_bool(context, L"hasAudio", merged.has_audio);
  log_event(LogLevel::info, "session.merged", context);
  return result;
}

void HostServer::stop_active_session() noexcept {
  if (!session_) {
    return;
  }
  try {
    session_->stop();
    log_event(LogLevel::info, "session.finalized-on-close");
  } catch (...) {
    log_event(LogLevel::error, "session.stop.failed");
  }
  session_.reset();
}

void HostServer::send(std::string_view payload) {
  if (pipe_) {
    pipe_->write(encode_frame(payload));
  }
}

void HostServer::emit(std::string_view name, const json::JsonObject& data) {
  try {
    send(make_event(name, data));
  } catch (...) {
    log_event(LogLevel::warn, "host.event.dropped");
  }
}

void HostServer::emit_state(const std::string& session_id, std::string_view state,
                            const HostError* error) {
  json::JsonObject data;
  json::set_string(data, L"sessionId", session_id);
  json::set_string(data, L"state", state);
  if (error != nullptr) {
    json::set_object(data, L"error", error_object(*error));
  } else {
    json::set_null(data, L"error");
  }
  emit("session.state", data);
}

void HostServer::on_segment_closed(const std::string& session_id, const SegmentInfo& segment) {
  auto data = segment_object(segment);
  json::set_string(data, L"sessionId", session_id);
  emit("session.segment", data);
}

void HostServer::on_metrics(const std::string& session_id, const SessionMetrics& metrics) {
  json::JsonObject data;
  json::set_string(data, L"sessionId", session_id);
  json::set_int(data, L"elapsedUs", metrics.elapsed_us);
  json::set_int(data, L"framesCaptured", static_cast<std::int64_t>(metrics.frames_captured));
  json::set_int(data, L"framesEncoded", static_cast<std::int64_t>(metrics.frames_encoded));
  json::set_int(data, L"framesDropped", static_cast<std::int64_t>(metrics.frames_dropped));
  json::set_int(data, L"audioFrames", static_cast<std::int64_t>(metrics.audio_frames));
  json::set_int(data, L"audioDiscontinuities",
                static_cast<std::int64_t>(metrics.audio_discontinuities));
  emit("session.metrics", data);
}

void HostServer::on_stream_failed(const std::string& session_id, StreamKind stream,
                                  const HostError& error) {
  json::JsonObject data;
  json::set_string(data, L"sessionId", session_id);
  json::set_string(data, L"stream", to_string(stream));
  json::set_object(data, L"error", error_object(error));
  emit("session.stream-failed", data);
}

void HostServer::on_session_failed(const std::string& session_id, const HostError& error) {
  emit_state(session_id, "failed", &error);
}

}  // namespace usee::recorder_host
