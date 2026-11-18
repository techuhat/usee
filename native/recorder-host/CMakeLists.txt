cmake_minimum_required(VERSION 3.20)

project(recorder_host VERSION 0.4.0 LANGUAGES CXX)

if(NOT MSVC)
  message(FATAL_ERROR "The recorder host builds with MSVC and the Windows SDK only.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# Static CRT: the host ships without a VC++ redistributable dependency.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_library(recorder_host_core STATIC
  src/audio/microphone_capture.cpp
  src/audio/synthetic_audio_source.cpp
  src/capture/d3d_context.cpp
  src/capture/display_capture.cpp
  src/capture/displays.cpp
  src/capture/gpu_scaler.cpp
  src/capture/synthetic_source.cpp
  src/capture/windows.cpp
  src/encode/aac_encoder.cpp
  src/encode/audio_segment_writer.cpp
  src/encode/sample_pool.cpp
  src/encode/video_segment_writer.cpp
  src/host_server.cpp
  src/input/display_pointer_tracker.cpp
  src/input/pointer_stream_writer.cpp
  src/input/synthetic_pointer.cpp
  src/ipc/named_pipe_server.cpp
  src/media/segment_merger.cpp
  src/media/waveform.cpp
  src/protocol/framing.cpp
  src/protocol/json.cpp
  src/protocol/messages.cpp
  src/session/frame_store.cpp
  src/session/journal.cpp
  src/session/media_clock.cpp
  src/session/recording_session.cpp
  src/session/task_queue.cpp
  src/util/host_config.cpp
  src/util/host_error.cpp
  src/util/log.cpp
  src/util/sha256.cpp
  src/util/utf.cpp
)

target_include_directories(recorder_host_core PUBLIC src)
target_compile_definitions(recorder_host_core PUBLIC
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00 WINVER=0x0A00)
target_compile_options(recorder_host_core PUBLIC
  /W4 /WX /permissive- /utf-8 /Zc:__cplusplus /EHsc /bigobj /external:anglebrackets /external:W0)
target_precompile_headers(recorder_host_core PRIVATE src/pch.h)
target_link_libraries(recorder_host_core PUBLIC
  advapi32 avrt bcrypt d3d11 dwmapi dxgi mfplat mfreadwrite mfuuid ole32 oleaut32 shcore user32 windowsapp)

add_executable(recorder-host src/main.cpp)
target_precompile_headers(recorder-host PRIVATE src/pch.h)
target_link_libraries(recorder-host PRIVATE recorder_host_core)

enable_testing()
add_executable(recorder-host-tests
  tests/test_main.cpp
  tests/input_tests.cpp
  tests/media_tests.cpp
  tests/protocol_tests.cpp
  tests/session_tests.cpp
)
target_include_directories(recorder-host-tests PRIVATE tests)
target_precompile_headers(recorder-host-tests PRIVATE src/pch.h)
target_link_libraries(recorder-host-tests PRIVATE recorder_host_core)
add_test(NAME recorder-host-tests COMMAND recorder-host-tests)
