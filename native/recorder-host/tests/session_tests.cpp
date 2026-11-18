#include "pch.h"

#include <cstring>

#include "capture/d3d_context.h"
#include "capture/displays.h"
#include "capture/gpu_scaler.h"
#include "session/capture_latency.h"
#include "session/frame_store.h"
#include "session/media_clock.h"
#include "session/segment_naming.h"
#include "util/host_config.h"
#include "test_harness.h"

using namespace usee::recorder_host;

namespace {

// A BGRA texture whose pixel (x, y) is blue = x, green = y, so a copy shows where it came from.
winrt::com_ptr<ID3D11Texture2D> coordinate_texture(ID3D11Device* device, unsigned width,
                                                   unsigned height) {
  std::vector<std::uint32_t> pixels(std::size_t{width} * height);
  for (unsigned y = 0; y < height; ++y) {
    for (unsigned x = 0; x < width; ++x) {
      pixels[std::size_t{y} * width + x] = 0xFF800000u | (y << 8) | x;
    }
  }
  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  const D3D11_SUBRESOURCE_DATA data{pixels.data(), width * 4, 0};
  winrt::com_ptr<ID3D11Texture2D> texture;
  winrt::check_hresult(device->CreateTexture2D(&description, &data, texture.put()));
  return texture;
}

// The frame store's newest frame, read back to the CPU.
std::vector<std::uint32_t> read_latest(const D3DContext& d3d, FrameStore& store, FrameSize size) {
  const auto target = create_frame_texture(d3d.device.get(), size.width, size.height);
  CHECK(store.copy_latest_to(target.get()));
  D3D11_TEXTURE2D_DESC description{};
  target->GetDesc(&description);
  description.Usage = D3D11_USAGE_STAGING;
  description.BindFlags = 0;
  description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  winrt::com_ptr<ID3D11Texture2D> staging;
  winrt::check_hresult(d3d.device->CreateTexture2D(&description, nullptr, staging.put()));
  d3d.context->CopyResource(staging.get(), target.get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  winrt::check_hresult(d3d.context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
  std::vector<std::uint32_t> pixels(std::size_t{size.width} * size.height);
  for (unsigned y = 0; y < size.height; ++y) {
    std::memcpy(&pixels[std::size_t{y} * size.width],
                static_cast<const std::uint8_t*>(mapped.pData) + std::size_t{y} * mapped.RowPitch,
                std::size_t{size.width} * 4);
  }
  d3d.context->Unmap(staging.get(), 0);
  return pixels;
}

}  // namespace

TEST(frame_store_keeps_only_the_region_of_each_frame) {
  const D3DContext d3d = create_d3d_context();
  const auto source = coordinate_texture(d3d.device.get(), 64, 32);
  FrameStore store(d3d.device.get(), d3d.context, FrameRegion{10, 6, 20, 12}, FrameSize{20, 12});
  store.publish(source.get(), FrameSize{64, 32}, 0);

  const auto pixels = read_latest(d3d, store, FrameSize{20, 12});
  CHECK(pixels.front() == (0xFF800000u | (6u << 8) | 10u));
  CHECK(pixels.back() == (0xFF800000u | (17u << 8) | 29u));
}

TEST(frame_store_scales_the_region_alone) {
  const D3DContext d3d = create_d3d_context();
  // WARP has no video processor to scale with, and neither has the software adapter a
  // machine without a GPU, such as GitHub's Windows runner, offers as its hardware one.
  if (!d3d.device.try_as<ID3D11VideoDevice>() || !d3d.context.try_as<ID3D11VideoContext>()) {
    return;
  }
  // Red on the left half, blue on the right: a scaled right half has no red in it.
  std::vector<std::uint32_t> halves(64 * 32);
  for (unsigned i = 0; i < halves.size(); ++i) {
    halves[i] = (i % 64) < 32 ? 0xFFFF0000u : 0xFF0000FFu;
  }
  D3D11_TEXTURE2D_DESC description{};
  description.Width = 64;
  description.Height = 32;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  const D3D11_SUBRESOURCE_DATA data{halves.data(), 64 * 4, 0};
  winrt::com_ptr<ID3D11Texture2D> source;
  winrt::check_hresult(d3d.device->CreateTexture2D(&description, &data, source.put()));

  FrameStore store(d3d.device.get(), d3d.context, FrameRegion{32, 0, 32, 32}, FrameSize{16, 16});
  store.publish(source.get(), FrameSize{64, 32}, 0);
  for (const std::uint32_t pixel : read_latest(d3d, store, FrameSize{16, 16})) {
    CHECK(((pixel >> 16) & 0xFF) < 16);   // red
    CHECK((pixel & 0xFF) > 224);          // blue
  }
}

TEST(frame_store_says_when_its_picture_was_composed_and_whether_it_is_new) {
  const D3DContext d3d = create_d3d_context();
  const auto source = coordinate_texture(d3d.device.get(), 32, 16);
  const auto target = create_frame_texture(d3d.device.get(), 32, 16);
  FrameStore store(d3d.device.get(), d3d.context, FrameRegion{0, 0, 32, 16}, FrameSize{32, 16});
  CHECK(!store.copy_latest_to(target.get()));

  store.publish(source.get(), FrameSize{32, 16}, 1'234);
  const auto first = store.copy_latest_to(target.get());
  CHECK(first && first->capture_hns == 1'234 && first->fresh);
  // Encoded again before another arrives: the same picture, no longer new.
  const auto again = store.copy_latest_to(target.get());
  CHECK(again && again->capture_hns == 1'234 && !again->fresh);
  store.publish(source.get(), FrameSize{32, 16}, 5'678);
  const auto next = store.copy_latest_to(target.get());
  CHECK(next && next->capture_hns == 5'678 && next->fresh);
}

TEST(capture_latency_is_the_median_age_of_new_pictures) {
  CaptureLatencyMeter meter;
  CHECK(!meter.median_us());
  for (const std::int64_t ms : {12, 14, 30, 13, 15}) {
    meter.add(ms * 10'000 + 2'000);  // 12.2 ms and so on, in 100 ns units
  }
  CHECK(meter.median_us() == 14'500);  // 14.2 ms, at the middle of its millisecond
  CHECK(meter.percentile_us(0.2) == 12'500);
  CHECK(meter.percentile_us(0.9) == 30'500);
  CHECK(meter.samples() == 5 && meter.newer() == 0);
  // A picture shown after its frame time has a negative age, kept to the millisecond below.
  CaptureLatencyMeter newer;
  for (const std::int64_t hns : {-122'000, -112'000, -102'000}) {
    newer.add(hns);  // -12.2, -11.2 and -10.2 ms
  }
  CHECK(newer.median_us() == -11'500);  // -11.2 ms lies in [-12, -11) ms
  CHECK(newer.newer() == 3);
  CHECK(newer.youngest_us() == -12'200);
  // Beyond a quarter second before or three quarters after, an age is held at the end.
  CaptureLatencyMeter edges;
  edges.add(-5'000'000);
  CHECK(edges.median_us() == -249'500);
  edges.add(50'000'000);
  edges.add(50'000'000);
  CHECK(edges.median_us() == 749'500);
}

TEST(frame_times_are_exact_for_integer_and_ntsc_rates) {
  CHECK(frame_time_hns(0, 60, 1) == 0);
  CHECK(frame_time_hns(1, 60, 1) == 166'666);
  CHECK(frame_time_hns(60, 60, 1) == kHnsPerSecond);
  CHECK(frame_time_hns(600, 60, 1) == 10 * kHnsPerSecond);
  // 59.94 fps: 60000 frames take exactly 1001 seconds.
  CHECK(frame_time_hns(60'000, 60'000, 1001) == 1001 * kHnsPerSecond);
}

TEST(frame_index_at_inverts_frame_time) {
  for (std::int64_t index = 0; index < 5000; index += 7) {
    CHECK(frame_index_at(frame_time_hns(index, 60, 1), 60, 1) == index);
    CHECK(frame_index_at(frame_time_hns(index + 1, 60, 1) - 1, 60, 1) == index);
    CHECK(frame_index_at(frame_time_hns(index, 30'000, 1001), 30'000, 1001) == index);
  }
  CHECK(frame_index_at(-5, 60, 1) == 0);
}

TEST(audio_frame_durations_convert_exactly) {
  CHECK(audio_frames_to_hns(48'000, 48'000) == kHnsPerSecond);
  CHECK(audio_frames_to_hns(480, 48'000) == 100'000);
  CHECK(hns_to_us(166'666) == 16'666);
}

TEST(segment_file_names_sort_in_recording_order) {
  CHECK(segment_file_name(StreamKind::video, 0) == "video-00000.mp4");
  CHECK(segment_file_name(StreamKind::audio, 12) == "audio-00012.m4a");
  CHECK(segment_file_name(StreamKind::video, 9) < segment_file_name(StreamKind::video, 10));
}

TEST(stable_ids_are_opaque_and_deterministic) {
  const std::string id = stable_id("display", L"\\\\.\\DISPLAY1");
  CHECK(id.size() == std::string("display-").size() + 8);
  CHECK(id.rfind("display-", 0) == 0);
  CHECK(id == stable_id("display", L"\\\\.\\DISPLAY1"));
  CHECK(id != stable_id("display", L"\\\\.\\DISPLAY2"));
  CHECK(id.find('\\') == std::string::npos);
}

TEST(launch_configuration_is_validated) {
  CHECK(is_valid_pipe_name(L"\\\\.\\pipe\\usee-recorder-0123456789abcdef0123456789abcdef"));
  CHECK(!is_valid_pipe_name(L"\\\\.\\pipe\\usee-recorder-0123"));
  CHECK(!is_valid_pipe_name(L"\\\\.\\pipe\\other-0123456789abcdef0123456789abcdef"));
  CHECK(!is_valid_pipe_name(L"\\\\.\\pipe\\usee-recorder-0123456789ABCDEF0123456789abcdef"));

  CHECK(is_valid_token(std::string(64, 'a')));
  CHECK(!is_valid_token(std::string(63, 'a')));
  CHECK(!is_valid_token(std::string(64, 'g')));

  CHECK(tokens_equal("abc", "abc"));
  CHECK(!tokens_equal("abc", "abd"));
  CHECK(!tokens_equal("abc", "abcd"));
}

TEST(staging_root_must_be_a_local_directory) {
  const auto temp = std::filesystem::temp_directory_path();
  CHECK(is_acceptable_staging_root(temp));
  CHECK(!is_acceptable_staging_root(L"\\\\server\\share\\staging"));
  CHECK(!is_acceptable_staging_root(L"\\\\?\\C:\\staging"));
  CHECK(!is_acceptable_staging_root(L"relative\\staging"));
  CHECK(!is_acceptable_staging_root(temp / L"does-not-exist-7f3a"));
}

TEST(session_directories_stay_inside_the_staging_root) {
  const std::filesystem::path root = L"C:\\staging";
  CHECK(session_directory(root, "abc-123") == root / L"abc-123");
  CHECK_THROWS_AS(session_directory(root, ".."), std::invalid_argument);
  CHECK_THROWS_AS(session_directory(root, "a/../../b"), std::invalid_argument);
  CHECK_THROWS_AS(session_directory(root, "C:"), std::invalid_argument);
}

TEST(output_size_fits_1080p_and_keeps_the_aspect_ratio) {
  const FrameSize bounds{1920, 1080};
  const auto check = [&](FrameSize source, FrameSize expected) {
    const FrameSize actual = fit_within(source, bounds);
    CHECK(actual.width == expected.width && actual.height == expected.height);
  };
  check({3840, 2160}, {1920, 1080});
  check({2560, 1440}, {1920, 1080});
  check({1920, 1080}, {1920, 1080});
  check({1280, 720}, {1280, 720});
  check({1281, 721}, {1280, 720});  // odd sizes round down to even
  check({3440, 1440}, {1920, 802});  // ultrawide: width-bound
  check({1080, 1920}, {606, 1080});  // portrait: height-bound
}
