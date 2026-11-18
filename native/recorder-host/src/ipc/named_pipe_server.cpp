#include "pch.h"

#include "ipc/named_pipe_server.h"

#include "util/host_error.h"

namespace usee::recorder_host {

namespace {

constexpr DWORD kBufferBytes = 64 * 1024;

std::wstring current_user_sid() {
  winrt::handle token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token.put())) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::native, "native.token-unavailable");
  }
  DWORD size = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
  std::vector<std::byte> buffer(size);
  if (!GetTokenInformation(token.get(), TokenUser, buffer.data(), size, &size)) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::native, "native.token-unavailable");
  }
  const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  LPWSTR sid_text = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &sid_text)) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::native, "native.token-unavailable");
  }
  std::wstring sid{sid_text};
  LocalFree(sid_text);
  return sid;
}

winrt::handle create_event() {
  winrt::handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!event) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::native, "native.event-failed");
  }
  return event;
}

// Waits for an overlapped operation; returns false if shutdown was signalled
// first (the operation is then cancelled).
bool wait_for_io(HANDLE pipe, OVERLAPPED& overlapped, HANDLE shutdown_event, DWORD timeout_ms) {
  const HANDLE handles[] = {overlapped.hEvent, shutdown_event};
  const DWORD result = WaitForMultipleObjects(2, handles, FALSE, timeout_ms);
  if (result == WAIT_OBJECT_0) {
    return true;
  }
  CancelIoEx(pipe, &overlapped);
  DWORD ignored = 0;
  GetOverlappedResult(pipe, &overlapped, &ignored, TRUE);
  return false;
}

}  // namespace

NamedPipeServer::NamedPipeServer(const std::wstring& pipe_name)
    : read_event_(create_event()), write_event_(create_event()), shutdown_event_(create_event()) {
  const std::wstring sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + current_user_sid() + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                            &descriptor, nullptr)) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::native, "native.pipe-acl-failed");
  }
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor, FALSE};

  pipe_.attach(CreateNamedPipeW(
      pipe_name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1,
      kBufferBytes, kBufferBytes, 0, &attributes));
  const DWORD error = GetLastError();
  LocalFree(descriptor);
  if (pipe_.get() == INVALID_HANDLE_VALUE) {
    pipe_.detach();
    check_hr(HRESULT_FROM_WIN32(error), ErrorCategory::native, "native.pipe-create-failed");
  }
}

NamedPipeServer::~NamedPipeServer() {
  shutdown();
  if (pipe_) {
    // DisconnectNamedPipe discards unread data, so first wait until the client
    // has read the last responses (for example the reply to a rejected hello).
    if (connected_) {
      FlushFileBuffers(pipe_.get());
    }
    DisconnectNamedPipe(pipe_.get());
  }
}

bool NamedPipeServer::accept(std::chrono::milliseconds timeout) {
  OVERLAPPED overlapped{};
  overlapped.hEvent = read_event_.get();
  ResetEvent(overlapped.hEvent);

  if (ConnectNamedPipe(pipe_.get(), &overlapped)) {
    connected_ = true;
    return true;
  }
  const DWORD error = GetLastError();
  if (error == ERROR_PIPE_CONNECTED) {
    connected_ = true;
    return true;
  }
  if (error != ERROR_IO_PENDING) {
    check_hr(HRESULT_FROM_WIN32(error), ErrorCategory::native, "native.pipe-connect-failed");
  }
  if (!wait_for_io(pipe_.get(), overlapped, shutdown_event_.get(),
                   static_cast<DWORD>(timeout.count()))) {
    return false;
  }
  DWORD ignored = 0;
  if (!GetOverlappedResult(pipe_.get(), &overlapped, &ignored, FALSE)) {
    return false;
  }
  connected_ = true;
  return true;
}

unsigned long NamedPipeServer::client_process_id() const {
  ULONG process_id = 0;
  GetNamedPipeClientProcessId(pipe_.get(), &process_id);
  return process_id;
}

std::optional<std::string> NamedPipeServer::read() {
  std::string buffer(kBufferBytes, '\0');
  OVERLAPPED overlapped{};
  overlapped.hEvent = read_event_.get();
  ResetEvent(overlapped.hEvent);

  DWORD bytes = 0;
  if (!ReadFile(pipe_.get(), buffer.data(), kBufferBytes, &bytes, &overlapped)) {
    const DWORD error = GetLastError();
    if (error != ERROR_IO_PENDING) {
      connected_ = false;
      return std::nullopt;
    }
    if (!wait_for_io(pipe_.get(), overlapped, shutdown_event_.get(), INFINITE)) {
      connected_ = false;
      return std::nullopt;
    }
    if (!GetOverlappedResult(pipe_.get(), &overlapped, &bytes, FALSE)) {
      connected_ = false;
      return std::nullopt;
    }
  }
  if (bytes == 0) {
    connected_ = false;
    return std::nullopt;
  }
  buffer.resize(bytes);
  return buffer;
}

bool NamedPipeServer::write(std::string_view bytes) {
  std::lock_guard lock(write_mutex_);
  size_t offset = 0;
  while (connected_ && offset < bytes.size()) {
    OVERLAPPED overlapped{};
    overlapped.hEvent = write_event_.get();
    ResetEvent(overlapped.hEvent);

    const auto chunk = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, kBufferBytes));
    DWORD written = 0;
    if (!WriteFile(pipe_.get(), bytes.data() + offset, chunk, &written, &overlapped)) {
      if (GetLastError() != ERROR_IO_PENDING ||
          !GetOverlappedResult(pipe_.get(), &overlapped, &written, TRUE)) {
        connected_ = false;
        return false;
      }
    }
    offset += written;
  }
  return connected_;
}

void NamedPipeServer::shutdown() noexcept {
  if (shutdown_event_) {
    SetEvent(shutdown_event_.get());
  }
}

unsigned long parent_process_id() {
  const winrt::handle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)};
  if (snapshot.get() == INVALID_HANDLE_VALUE) {
    return 0;
  }
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  const DWORD self = GetCurrentProcessId();
  for (BOOL found = Process32FirstW(snapshot.get(), &entry); found;
       found = Process32NextW(snapshot.get(), &entry)) {
    if (entry.th32ProcessID == self) {
      return entry.th32ParentProcessID;
    }
  }
  return 0;
}

}  // namespace usee::recorder_host
