#pragma once

#include <memory>
#include <optional>
#include <string>

#include "capture/d3d_context.h"
#include "ipc/named_pipe_server.h"
#include "protocol/messages.h"
#include "session/recording_session.h"
#include "util/host_config.h"

namespace usee::recorder_host {

// Serves exactly one authenticated client for the life of the process
// (docs/recorder-host-protocol.md). If the client disconnects, an active
// session is finalized before the host exits, so no recorded segment is lost.
class HostServer final : public SessionObserver {
 public:
  explicit HostServer(HostConfig config);
  ~HostServer() override;

  // Returns the process exit code.
  int run();

  void on_segment_closed(const std::string& session_id, const SegmentInfo& segment) override;
  void on_metrics(const std::string& session_id, const SessionMetrics& metrics) override;
  void on_stream_failed(const std::string& session_id, StreamKind stream,
                        const HostError& error) override;
  void on_session_failed(const std::string& session_id, const HostError& error) override;

 private:
  void dispatch(const Request& request);
  json::JsonObject handle_hello(const json::JsonObject& params);
  json::JsonObject handle_list_displays();
  json::JsonObject handle_list_windows();
  json::JsonObject handle_list_audio_inputs();
  json::JsonObject handle_start_session(const json::JsonObject& params);
  json::JsonObject handle_stop_session(const json::JsonObject& params);
  json::JsonObject handle_merge_session(const json::JsonObject& params);

  const D3DContext& d3d();
  void send(std::string_view payload);
  void emit(std::string_view name, const json::JsonObject& data);
  void emit_state(const std::string& session_id, std::string_view state,
                  const HostError* error = nullptr);
  void stop_active_session() noexcept;

  HostConfig config_;
  std::unique_ptr<NamedPipeServer> pipe_;
  bool authenticated_ = false;
  bool closing_ = false;
  std::optional<D3DContext> d3d_;
  std::unique_ptr<RecordingSession> session_;
};

}  // namespace usee::recorder_host
