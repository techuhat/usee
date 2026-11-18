#include "pch.h"

#include "input/pointer_stream_writer.h"

#include <cstdio>

#include "session/media_clock.h"
#include "util/host_error.h"
#include "util/log.h"

namespace usee::recorder_host {

namespace {

constexpr std::int64_t kFlushIntervalHns = 5'000'000;  // 500 ms

const char* type_name(PointerEventType type) noexcept {
  switch (type) {
    case PointerEventType::move:
      return "move";
    case PointerEventType::down:
      return "down";
    case PointerEventType::up:
      return "up";
    case PointerEventType::shape:
      return "shape";
    case PointerEventType::visibility:
      return "visibility";
  }
  return "move";
}

}  // namespace

std::string format_pointer_event(const PointerEvent& event, std::int64_t time_us) {
  char line[160]{};
  const char* type = type_name(event.type);
  switch (event.type) {
    case PointerEventType::move:
      std::snprintf(line, sizeof(line), "{\"t\":%lld,\"type\":\"%s\",\"x\":%.5f,\"y\":%.5f}",
                    static_cast<long long>(time_us), type, event.x, event.y);
      break;
    case PointerEventType::down:
    case PointerEventType::up:
      std::snprintf(line, sizeof(line),
                    "{\"t\":%lld,\"type\":\"%s\",\"button\":\"%s\",\"x\":%.5f,\"y\":%.5f}",
                    static_cast<long long>(time_us), type,
                    event.button != nullptr ? event.button : "left", event.x, event.y);
      break;
    case PointerEventType::shape:
      std::snprintf(line, sizeof(line), "{\"t\":%lld,\"type\":\"%s\",\"shape\":\"%s\"}",
                    static_cast<long long>(time_us), type,
                    event.shape != nullptr ? event.shape : "arrow");
      break;
    case PointerEventType::visibility:
      std::snprintf(line, sizeof(line), "{\"t\":%lld,\"type\":\"%s\",\"visible\":%s}",
                    static_cast<long long>(time_us), type, event.visible ? "true" : "false");
      break;
  }
  return line;
}

PointerStreamWriter::PointerStreamWriter(const std::filesystem::path& path,
                                         const PointerStreamHeader& header,
                                         std::int64_t epoch_hns)
    : epoch_hns_(epoch_hns), last_flush_hns_(qpc_now_hns()) {
  file_.attach(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
                           FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file_) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::storage,
             "storage.pointer-create-failed");
  }
  // The session ID is an opaque [A-Za-z0-9_-] identifier, so it needs no escaping.
  char line[256]{};
  std::snprintf(line, sizeof(line),
                "{\"format\":\"usee.pointer\",\"version\":1,\"sessionId\":\"%s\","
                "\"coordinateSpace\":\"capture\",\"display\":{\"width\":%u,\"height\":%u,"
                "\"dpiScale\":%.4f}}\n",
                header.session_id.c_str(), header.display_width, header.display_height,
                header.dpi_scale);
  buffer_ = line;
  write_buffer();
}

PointerStreamWriter::~PointerStreamWriter() { close(); }

void PointerStreamWriter::append(const PointerEvent& event) {
  const std::int64_t time_us = hns_to_us(event.qpc_hns - epoch_hns_);
  if (time_us < 0) {
    return;
  }
  std::lock_guard lock(mutex_);
  if (!file_) {
    return;
  }
  buffer_ += format_pointer_event(event, time_us);
  buffer_ += '\n';
  const std::int64_t now = qpc_now_hns();
  if (now - last_flush_hns_ < kFlushIntervalHns) {
    return;
  }
  last_flush_hns_ = now;
  try {
    write_buffer();
  } catch (const HostError&) {
    // The recording goes on; only the pointer stream stops here.
    log_event(LogLevel::warn, "session.pointer.write-failed");
    file_.close();
  }
}

void PointerStreamWriter::close() noexcept {
  std::lock_guard lock(mutex_);
  if (!file_) {
    return;
  }
  try {
    write_buffer();
  } catch (...) {
    log_event(LogLevel::warn, "session.pointer.write-failed");
  }
  file_.close();
}

void PointerStreamWriter::write_buffer() {
  if (buffer_.empty()) {
    return;
  }
  DWORD written = 0;
  const bool ok = WriteFile(file_.get(), buffer_.data(), static_cast<DWORD>(buffer_.size()),
                            &written, nullptr) &&
                  written == buffer_.size() && FlushFileBuffers(file_.get());
  buffer_.clear();
  if (!ok) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::storage,
             "storage.pointer-write-failed");
  }
}

}  // namespace usee::recorder_host
