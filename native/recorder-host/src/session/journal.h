#pragma once

#include <filesystem>
#include <mutex>

#include "protocol/json.h"

namespace usee::recorder_host {

// Append-only NDJSON session journal. Every record is flushed to disk before
// append() returns, so after a crash the journal lists exactly the segments
// that were finalized (docs/recording-pipeline.md, "Live encoding and durability").
class Journal {
 public:
  // Creates the file; fails if it already exists.
  explicit Journal(const std::filesystem::path& path);

  void append(const json::JsonObject& record);

 private:
  winrt::file_handle file_;
  std::mutex mutex_;
};

}  // namespace usee::recorder_host
