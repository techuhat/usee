#include "pch.h"

#include "util/log.h"

#include <cstdio>

namespace usee::recorder_host {

namespace {

std::mutex& output_mutex() {
  static std::mutex mutex;
  return mutex;
}

const char* level_name(LogLevel level) noexcept {
  switch (level) {
    case LogLevel::debug:
      return "DEBUG";
    case LogLevel::info:
      return "INFO";
    case LogLevel::warn:
      return "WARN";
    case LogLevel::error:
      return "ERROR";
    case LogLevel::fatal:
      return "FATAL";
  }
  return "INFO";
}

std::string utc_timestamp() {
  FILETIME file_time{};
  GetSystemTimePreciseAsFileTime(&file_time);
  SYSTEMTIME time{};
  FileTimeToSystemTime(&file_time, &time);
  char buffer[32]{};
  std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", time.wYear,
                time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond,
                time.wMilliseconds);
  return buffer;
}

}  // namespace

void log_event(LogLevel level, std::string_view event, const json::JsonObject& context) {
  try {
    json::JsonObject record;
    json::set_string(record, L"timestamp", utc_timestamp());
    json::set_string(record, L"level", level_name(level));
    json::set_string(record, L"event", event);
    json::set_string(record, L"module", "recorder-host");
    json::set_int(record, L"processId", static_cast<std::int64_t>(GetCurrentProcessId()));
    if (context) {
      json::set_object(record, L"safeContext", context);
    }
    const std::string line = json::stringify(record) + "\n";

    std::lock_guard lock(output_mutex());
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fflush(stdout);
  } catch (...) {
    // Logging must never take the host down.
  }
}

}  // namespace usee::recorder_host
