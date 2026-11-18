#include "pch.h"

#include <cstdio>

#include "test_harness.h"

int wmain() {
  // Unbuffered, so a test that ends the process still leaves its name in a piped log.
  std::setvbuf(stdout, nullptr, _IONBF, 0);

  // Windows.Data.Json needs the WinRT runtime; the media tests need Media Foundation.
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET))) {
    std::printf("Media Foundation is unavailable\n");
    return 1;
  }

  int failures = 0;
  for (const auto& test_case : test::registry()) {
    std::printf("  %s ... ", test_case.name);
    try {
      test_case.body();
      std::printf("ok\n");
    } catch (const std::exception& error) {
      ++failures;
      std::printf("FAIL\n        %s\n", error.what());
    } catch (const winrt::hresult_error& error) {
      // Not a std::exception: uncaught, it would end the run without a word.
      ++failures;
      std::printf("FAIL\n        HRESULT 0x%08X: %s\n", static_cast<unsigned>(error.code().value),
                  winrt::to_string(error.message()).c_str());
    }
  }
  std::printf("%zu tests, %d failed\n", test::registry().size(), failures);
  return failures == 0 ? 0 : 1;
}
