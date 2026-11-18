#include "pch.h"

#include "session/journal.h"

#include "util/host_error.h"

namespace usee::recorder_host {

Journal::Journal(const std::filesystem::path& path) {
  file_.attach(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
                           FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file_) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::storage,
             "storage.journal-create-failed");
  }
}

void Journal::append(const json::JsonObject& record) {
  const std::string line = json::stringify(record) + "\n";
  std::lock_guard lock(mutex_);
  DWORD written = 0;
  if (!WriteFile(file_.get(), line.data(), static_cast<DWORD>(line.size()), &written, nullptr) ||
      written != line.size() || !FlushFileBuffers(file_.get())) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::storage,
             "storage.journal-write-failed");
  }
}

}  // namespace usee::recorder_host
