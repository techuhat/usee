#include "pch.h"

#include <fstream>
#include <sstream>

#include "capture/windows.h"
#include "input/display_pointer_tracker.h"
#include "input/pointer_stream_writer.h"
#include "input/synthetic_pointer.h"
#include "session/media_clock.h"
#include "test_harness.h"

using namespace usee::recorder_host;

TEST(pointer_events_format_as_ndjson_lines) {
  PointerEvent move;
  move.x = 0.123456789;
  move.y = -0.5;
  CHECK(format_pointer_event(move, 1'500) == R"({"t":1500,"type":"move","x":0.12346,"y":-0.50000})");

  PointerEvent down;
  down.type = PointerEventType::down;
  down.button = "right";
  down.x = 1.25;
  down.y = 0.5;
  CHECK(format_pointer_event(down, 2) ==
        R"({"t":2,"type":"down","button":"right","x":1.25000,"y":0.50000})");

  PointerEvent shape;
  shape.type = PointerEventType::shape;
  shape.shape = "text";
  CHECK(format_pointer_event(shape, 3) == R"({"t":3,"type":"shape","shape":"text"})");

  PointerEvent hidden;
  hidden.type = PointerEventType::visibility;
  hidden.visible = false;
  CHECK(format_pointer_event(hidden, 4) == R"({"t":4,"type":"visibility","visible":false})");
}

TEST(synthetic_pointer_circles_and_clicks_once_a_second) {
  const auto start = synthetic_pointer_at(0);
  CHECK(std::abs(start.x - 0.8) < 1e-9 && std::abs(start.y - 0.5) < 1e-9);
  const auto quarter = synthetic_pointer_at(kHnsPerSecond);
  CHECK(std::abs(quarter.x - 0.5) < 1e-9 && std::abs(quarter.y - 0.8) < 1e-9);
  CHECK(std::string_view(start.shape) == "arrow");
  CHECK(std::string_view(synthetic_pointer_at(3 * kHnsPerSecond).shape) == "pointer");

  CHECK(!synthetic_pointer_at(kHnsPerSecond / 2 - 1).pressed);
  CHECK(synthetic_pointer_at(kHnsPerSecond / 2).pressed);
  CHECK(synthetic_pointer_at(kHnsPerSecond / 2 + kHnsPerSecond / 10 - 1).pressed);
  CHECK(!synthetic_pointer_at(kHnsPerSecond / 2 + kHnsPerSecond / 10).pressed);
  CHECK(synthetic_pointer_at(7 * kHnsPerSecond / 2).pressed);
}

TEST(cursor_shapes_map_standard_cursors_and_default_to_the_arrow) {
  CHECK(std::string_view(cursor_shape_name(LoadCursorW(nullptr, IDC_IBEAM))) == "text");
  CHECK(std::string_view(cursor_shape_name(LoadCursorW(nullptr, IDC_HAND))) == "pointer");
  CHECK(std::string_view(cursor_shape_name(LoadCursorW(nullptr, IDC_SIZEWE))) == "ew-resize");
  CHECK(std::string_view(cursor_shape_name(nullptr)) == "arrow");
}

TEST(pointer_stream_has_a_header_and_drops_events_before_the_epoch) {
  wchar_t temp[MAX_PATH]{};
  CHECK(GetTempPathW(MAX_PATH, temp) > 0);
  const auto path = std::filesystem::path(temp) /
                    (L"recorder-host-pointer-" + std::to_wstring(GetCurrentProcessId()) + L".ndjson");
  std::filesystem::remove(path);
  const std::int64_t epoch = 50 * kHnsPerSecond;
  {
    PointerStreamHeader header;
    header.session_id = "session-1";
    header.display_width = 3840;
    header.display_height = 2160;
    header.dpi_scale = 2.0;
    PointerStreamWriter writer(path, header, epoch);
    PointerEvent early;
    early.qpc_hns = epoch - 10;
    writer.append(early);
    PointerEvent move;
    move.qpc_hns = epoch + 2'500'000;  // 250 ms
    move.x = 0.25;
    move.y = 0.75;
    writer.append(move);
    writer.close();
  }
  std::ifstream input(path);
  std::stringstream text;
  text << input.rdbuf();
  input.close();
  std::filesystem::remove(path);

  CHECK(text.str() ==
        "{\"format\":\"usee.pointer\",\"version\":1,\"sessionId\":\"session-1\","
        "\"coordinateSpace\":\"capture\",\"display\":{\"width\":3840,\"height\":2160,"
        "\"dpiScale\":2.0000}}\n"
        "{\"t\":250000,\"type\":\"move\",\"x\":0.25000,\"y\":0.75000}\n");
}

TEST(window_ids_are_opaque_and_name_the_handle) {
  using usee::recorder_host::window_id;
  CHECK(window_id(reinterpret_cast<HWND>(static_cast<std::uintptr_t>(0x1234))) ==
        "window-0000000000001234");
  CHECK(window_id(reinterpret_cast<HWND>(static_cast<std::uintptr_t>(0xabcdef01))) ==
        "window-00000000abcdef01");
}

TEST(window_titles_are_bounded_and_always_convert) {
  using usee::recorder_host::picker_title;
  // Any app may put a lone surrogate in its title; the strict conversion would refuse it.
  CHECK(picker_title(std::wstring{L'a', wchar_t(0xD800), L'b'}) == "a\xEF\xBF\xBD" "b");
  CHECK(picker_title(std::wstring{wchar_t(0xDC00)}) == "\xEF\xBF\xBD");
  CHECK(picker_title(std::wstring{wchar_t(0xD83D), wchar_t(0xDE00)}) == "\xF0\x9F\x98\x80");
  // Long titles are cut to 128 UTF-16 units, never between the halves of a pair.
  CHECK(picker_title(std::wstring(300, L'y')) == std::string(128, 'y'));
  std::wstring pair_at_the_cut(127, L'x');
  pair_at_the_cut += wchar_t(0xD83D);
  pair_at_the_cut += wchar_t(0xDE00);
  CHECK(picker_title(pair_at_the_cut) == std::string(127, 'x'));
}

TEST(listed_windows_have_titles_ids_and_sizes) {
  // Whatever this machine has open: each listed window must be choosable.
  for (const auto& window : usee::recorder_host::enumerate_windows(GetCurrentProcessId())) {
    CHECK(!window.title.empty());
    CHECK(window.id == usee::recorder_host::window_id(window.hwnd));
    CHECK(window.width >= 2 && window.height >= 2);
    CHECK(IsWindowVisible(window.hwnd) && !IsIconic(window.hwnd));
  }
}
