#pragma once

#include <atomic>
#include <chrono>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>

#include <winrt/base.h>

namespace usee::recorder_host {

// One-connection named pipe server. The pipe admits only the current user and
// SYSTEM, rejects remote clients and fails if another process already owns the
// name (FILE_FLAG_FIRST_PIPE_INSTANCE), so it cannot be squatted silently.
// Reads and writes use overlapped I/O so a pending read never blocks a write.
class NamedPipeServer {
 public:
  explicit NamedPipeServer(const std::wstring& pipe_name);
  ~NamedPipeServer();

  NamedPipeServer(const NamedPipeServer&) = delete;
  NamedPipeServer& operator=(const NamedPipeServer&) = delete;

  // Waits for the client. Returns false on timeout or shutdown.
  bool accept(std::chrono::milliseconds timeout);

  // Process ID of the connected client.
  unsigned long client_process_id() const;

  // Blocks until bytes arrive. Returns nullopt when the client disconnects or
  // shutdown() is called.
  std::optional<std::string> read();

  // Thread-safe. Returns false once the client is gone.
  bool write(std::string_view bytes);

  // Unblocks read() and accept() from any thread.
  void shutdown() noexcept;

 private:
  winrt::handle pipe_;
  winrt::handle read_event_;
  winrt::handle write_event_;
  winrt::handle shutdown_event_;
  std::mutex write_mutex_;
  std::atomic<bool> connected_{false};
};

// Parent process ID of the current process, or 0 if it cannot be determined.
unsigned long parent_process_id();

}  // namespace usee::recorder_host
