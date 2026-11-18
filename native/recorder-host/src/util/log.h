#pragma once

#include <string_view>

#include "protocol/json.h"

namespace usee::recorder_host {

enum class LogLevel { debug, info, warn, error, fatal };

// Writes one NDJSON record to stdout, which Electron main forwards into its
// own log (docs/logging.md). `context` holds support-safe values only: never
// paths, device or window names, tokens or pixel data. Thread-safe.
void log_event(LogLevel level, std::string_view event,
               const json::JsonObject& context = json::JsonObject{nullptr});

}  // namespace usee::recorder_host
