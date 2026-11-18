#include "pch.h"

#include <cstdio>

#include "test_harness.h"

int wmain() {
  // Windows.Data.Json needs the WinRT runtime; the media tests need Media Foundation.
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET))) {
    std::printf("Media Foundation is unavailable\n");
    return 1;
  }

  int failures = 0;
  for (const auto& test_case : test::registry()) {
    try {
      test_case.body();
      std::printf("  ok    %s\n", test_case.name);
    } catch (const std::exception& error) {
      ++failures;
      std::printf("  FAIL  %s\n        %s\n", test_case.name, error.what());
    }
  }
  std::printf("%zu tests, %d failed\n", test::registry().size(), failures);
  return failures == 0 ? 0 : 1;
}
