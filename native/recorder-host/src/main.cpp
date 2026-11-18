#include "pch.h"

#include "host_server.h"
#include "protocol/messages.h"
#include "util/host_config.h"
#include "util/log.h"

using namespace usee::recorder_host;

// Exit codes: 0 clean, 1 fatal error, 2 invalid launch configuration,
// 3 no client connected in time, 4 client rejected.
int wmain() {
  // No error dialogs from a background process; never load DLLs from the
  // current directory.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  SetDllDirectoryW(L"");
  // Monitor rectangles and capture sizes are physical pixels.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    check_hr(MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET), ErrorCategory::native,
             "native.media-foundation-unavailable");

    HostConfig config = read_host_config_from_environment();
    json::JsonObject context;
    json::set_string(context, L"hostVersion", kHostVersion);
    json::set_int(context, L"protocolMajor", kProtocolMajor);
    json::set_bool(context, L"syntheticSource", config.synthetic_source_enabled);
    log_event(LogLevel::info, "host.started", context);

    int exit_code = 0;
    {
      HostServer server(std::move(config));
      exit_code = server.run();
    }
    MFShutdown();
    log_event(LogLevel::info, "host.stopped");
    return exit_code;
  } catch (const std::invalid_argument&) {
    log_event(LogLevel::fatal, "host.config.invalid");
    return 2;
  } catch (const HostError& error) {
    json::JsonObject context;
    json::set_string(context, L"code", error.code());
    log_event(LogLevel::fatal, "host.failed", context);
    return 1;
  } catch (...) {
    log_event(LogLevel::fatal, "host.failed");
    return 1;
  }
}
