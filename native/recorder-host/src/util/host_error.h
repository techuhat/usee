#pragma once

#include <stdexcept>
#include <string>

namespace usee::recorder_host {

// Categories the host reports; they map onto AppError categories in contracts.
enum class ErrorCategory { capture, audio, encoding, storage, native };

const char* to_string(ErrorCategory category) noexcept;

// Thrown inside the host and translated into a protocol error response at the
// request boundary. `code` is "<category>.<kebab-case-reason>"; `detail` is
// support-safe text (an HRESULT, never a path, device or window name).
class HostError : public std::runtime_error {
 public:
  HostError(ErrorCategory category, std::string code, bool retryable, std::string detail = {});

  ErrorCategory category() const noexcept { return category_; }
  const std::string& code() const noexcept { return code_; }
  bool retryable() const noexcept { return retryable_; }
  const std::string& detail() const noexcept { return detail_; }

 private:
  ErrorCategory category_;
  std::string code_;
  bool retryable_;
  std::string detail_;
};

// Throws HostError when `hr` is a failure, with the HRESULT as detail.
void check_hr(long hr, ErrorCategory category, const char* code, bool retryable = false);

// Formats an HRESULT as 0xXXXXXXXX.
std::string format_hresult(long hr);

}  // namespace usee::recorder_host
