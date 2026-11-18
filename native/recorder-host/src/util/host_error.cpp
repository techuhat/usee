#include "pch.h"

#include "util/host_error.h"

#include <cstdio>

namespace usee::recorder_host {

const char* to_string(ErrorCategory category) noexcept {
  switch (category) {
    case ErrorCategory::capture:
      return "capture";
    case ErrorCategory::audio:
      return "audio";
    case ErrorCategory::encoding:
      return "encoding";
    case ErrorCategory::storage:
      return "storage";
    case ErrorCategory::native:
      return "native";
  }
  return "native";
}

HostError::HostError(ErrorCategory category, std::string code, bool retryable, std::string detail)
    : std::runtime_error(code),
      category_(category),
      code_(std::move(code)),
      retryable_(retryable),
      detail_(std::move(detail)) {}

std::string format_hresult(long hr) {
  char buffer[16]{};
  std::snprintf(buffer, sizeof(buffer), "0x%08lX", static_cast<unsigned long>(hr));
  return buffer;
}

void check_hr(long hr, ErrorCategory category, const char* code, bool retryable) {
  if (FAILED(hr)) {
    throw HostError(category, code, retryable, format_hresult(hr));
  }
}

}  // namespace usee::recorder_host
