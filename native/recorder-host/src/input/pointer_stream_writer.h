#pragma once

#include <filesystem>
#include <mutex>
#include <string>

#include "input/pointer_events.h"

namespace usee::recorder_host {

struct PointerStreamHeader {
  std::string session_id;
  // The captured display in physical pixels, and its scale factor.
  unsigned display_width = 0;
  unsigned display_height = 0;
  double dpi_scale = 1.0;
};

// Writes `pointer.ndjson`: a header line, then one event per line in session
// microseconds. Lines are buffered and flushed to disk at least every half
// second, so a crash loses at most that much (docs/recorder-host-protocol.md).
class PointerStreamWriter {
 public:
  PointerStreamWriter(const std::filesystem::path& path, const PointerStreamHeader& header,
                      std::int64_t epoch_hns);
  ~PointerStreamWriter();

  PointerStreamWriter(const PointerStreamWriter&) = delete;
  PointerStreamWriter& operator=(const PointerStreamWriter&) = delete;

  // Thread-safe. Events before the session epoch are dropped.
  void append(const PointerEvent& event);
  // Writes whatever is buffered; idempotent.
  void close() noexcept;

 private:
  void write_buffer();

  winrt::file_handle file_;
  std::mutex mutex_;
  std::string buffer_;
  std::int64_t epoch_hns_;
  std::int64_t last_flush_hns_;
};

// One event as its NDJSON line, without the newline. Exposed for tests.
std::string format_pointer_event(const PointerEvent& event, std::int64_t time_us);

}  // namespace usee::recorder_host
