#include "pch.h"

#include "util/utf.h"

namespace usee::recorder_host {

std::string to_utf8(std::wstring_view text) {
  if (text.empty()) {
    return {};
  }
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
                                         static_cast<int>(text.size()), nullptr, 0, nullptr,
                                         nullptr);
  if (length <= 0) {
    throw std::invalid_argument("Invalid UTF-16 text.");
  }
  std::string result(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
                      result.data(), length, nullptr, nullptr);
  return result;
}

std::wstring to_wide(std::string_view text) {
  if (text.empty()) {
    return {};
  }
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                         static_cast<int>(text.size()), nullptr, 0);
  if (length <= 0) {
    throw std::invalid_argument("Invalid UTF-8 text.");
  }
  std::wstring result(static_cast<size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
                      result.data(), length);
  return result;
}

}  // namespace usee::recorder_host
