#include "pch.h"

#include <cstdlib>

#include "audio/synthetic_audio_source.h"
#include "encode/aac_encoder.h"
#include "media/segment_merger.h"
#include "media/waveform.h"
#include "test_harness.h"

using namespace usee::recorder_host;

namespace {

SegmentInfo segment(StreamKind stream, int index, std::int64_t start_us, std::int64_t duration_us) {
  SegmentInfo info;
  info.stream = stream;
  info.index = index;
  info.file_name = segment_file_name(stream, index);
  info.start_us = start_us;
  info.duration_us = duration_us;
  return info;
}

std::string plan_error(std::vector<SegmentInfo> segments) {
  try {
    plan_merge(std::move(segments));
  } catch (const HostError& error) {
    return error.code();
  }
  return {};
}

}  // namespace

TEST(synthetic_audio_is_a_tone_for_half_of_each_second) {
  int loudest = 0;
  for (std::int64_t frame = 0; frame < kAudioSampleRate / 2; ++frame) {
    loudest = std::max(loudest, std::abs(static_cast<int>(synthetic_audio_sample(frame))));
  }
  CHECK(loudest > 8'000 && loudest <= 8'192);
  for (std::int64_t frame = kAudioSampleRate / 2; frame < kAudioSampleRate; frame += 97) {
    CHECK(synthetic_audio_sample(frame) == 0);
  }
  CHECK(synthetic_audio_sample(kAudioSampleRate + 100) == synthetic_audio_sample(100));
}

TEST(aac_encoder_emits_numbered_frames_of_1024_samples) {
  AacEncoder encoder(kAudioSampleRate, kAudioChannels);
  std::vector<std::int16_t> packet(480 * kAudioChannels);
  std::vector<std::int64_t> indices;
  const AacFrameCallback on_frame = [&](IMFSample* frame, std::int64_t index) {
    DWORD bytes = 0;
    CHECK(SUCCEEDED(frame->GetTotalLength(&bytes)) && bytes > 0);
    indices.push_back(index);
  };
  for (std::int64_t position = 0; position < kAudioSampleRate; position += 480) {
    for (std::int64_t frame = 0; frame < 480; ++frame) {
      packet[frame * 2] = packet[frame * 2 + 1] = synthetic_audio_sample(position + frame);
    }
    encoder.encode(packet.data(), 480, on_frame);
  }
  encoder.drain(on_frame);

  // One second is 46.9 frames; the encoder adds at most a few for its delay.
  CHECK(indices.size() >= 47 && indices.size() <= 52);
  for (size_t index = 0; index < indices.size(); ++index) {
    CHECK(indices[index] == static_cast<std::int64_t>(index));
  }
  UINT32 rate = 0;
  CHECK(SUCCEEDED(encoder.output_type()->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate)));
  CHECK(rate == kAudioSampleRate);
  UINT32 config_bytes = 0;
  CHECK(SUCCEEDED(encoder.output_type()->GetBlobSize(MF_MT_USER_DATA, &config_bytes)));
  CHECK(config_bytes > 0);
}

TEST(peaks_cover_10_ms_buckets_of_all_channels) {
  PeakAccumulator accumulator(48'000, 2, 100);
  std::vector<std::int16_t> loud(480 * 2, 0);
  loud[7] = -32'768;  // the right channel's peak counts too
  const std::vector<std::int16_t> half(480 * 2, 16'384);
  accumulator.add(loud.data(), 480);
  accumulator.add(half.data(), 480);
  accumulator.add_silence(720);
  accumulator.add(half.data(), 10);
  const auto peaks = accumulator.finish();

  CHECK(peaks.size() == 4);
  CHECK(peaks[0] == 255);
  CHECK(peaks[1] == 128);
  CHECK(peaks[2] == 0);
  CHECK(peaks[3] == 128);  // 240 silent frames, then 10 at half scale
}

TEST(base64_matches_the_rfc_4648_vectors) {
  const auto encode = [](std::string_view text) {
    return base64_encode(std::vector<std::uint8_t>(text.begin(), text.end()));
  };
  CHECK(encode("").empty());
  CHECK(encode("f") == "Zg==");
  CHECK(encode("fo") == "Zm8=");
  CHECK(encode("foo") == "Zm9v");
  CHECK(encode("foob") == "Zm9vYg==");
  CHECK(encode("foobar") == "Zm9vYmFy");
  CHECK(base64_encode({0xFF, 0xEF}) == "/+8=");
}

TEST(journal_segments_are_read_and_foreign_names_ignored) {
  wchar_t temp[MAX_PATH]{};
  CHECK(GetTempPathW(MAX_PATH, temp) > 0);
  const auto path = std::filesystem::path(temp) /
                    (L"recorder-host-journal-" + std::to_wstring(GetCurrentProcessId()) + L".ndjson");
  const std::string sha(64, 'a');
  const std::string text =
      "{\"record\":\"session-started\",\"sessionId\":\"s\"}\n"
      "{\"record\":\"segment-closed\",\"stream\":\"video\",\"index\":0,\"fileName\":\"video-00000.mp4\","
      "\"startUs\":0,\"durationUs\":2000000,\"bytes\":10,\"sha256\":\"" + sha + "\",\"frames\":60}\n"
      "{\"record\":\"segment-closed\",\"stream\":\"video\",\"index\":1,\"fileName\":\"..\\\\x.mp4\","
      "\"startUs\":2000000,\"durationUs\":2000000,\"bytes\":10,\"sha256\":\"" + sha + "\",\"frames\":60}\n"
      "{\"record\":\"segment-closed\",\"stream\":\"audio\",\"index\":0,\"fileName\":\"audio-00000.m4a\","
      "\"startUs\":0,\"durationUs\":2005333,\"bytes\":9,\"sha256\":\"" + sha + "\",\"frames\":96256}\n"
      "{\"record\":\"segment-closed\",\"stream\":\"vid";  // cut off by a crash
  {
    const winrt::file_handle file{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                              FILE_ATTRIBUTE_NORMAL, nullptr)};
    DWORD written = 0;
    CHECK(WriteFile(file.get(), text.data(), static_cast<DWORD>(text.size()), &written, nullptr));
  }
  const auto segments = read_journal_segments(path);
  std::filesystem::remove(path);

  CHECK(segments.size() == 2);
  CHECK(segments[0].stream == StreamKind::video && segments[0].frames == 60);
  CHECK(segments[1].stream == StreamKind::audio && segments[1].duration_us == 2'005'333);
  CHECK_THROWS_AS(read_journal_segments(path), HostError);
}

TEST(merge_plans_order_segments_and_require_tiled_audio) {
  const auto plan = plan_merge({segment(StreamKind::video, 1, 2'000'000, 2'000'000),
                                segment(StreamKind::audio, 0, 0, 2'005'333),
                                segment(StreamKind::video, 0, 0, 1'966'666)});
  CHECK(plan.video.size() == 2 && plan.video[0].index == 0 && plan.video[1].index == 1);
  CHECK(plan.audio.size() == 1);

  // A video gap (frames dropped at a boundary) is fine; an overlap is not.
  CHECK(plan_error({segment(StreamKind::video, 0, 0, 2'000'000),
                    segment(StreamKind::video, 1, 1'999'999, 2'000'000)}) ==
        "encoding.merge-overlap");
  CHECK(plan_error({segment(StreamKind::video, 0, 0, 2'000'000),
                    segment(StreamKind::audio, 0, 0, 2'005'333),
                    segment(StreamKind::audio, 2, 4'010'666, 2'005'333)}) == "encoding.merge-gap");
  CHECK(plan_error({segment(StreamKind::audio, 0, 0, 2'005'333)}) == "storage.nothing-to-merge");
}
