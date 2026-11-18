#include "pch.h"

#include "media/waveform.h"

#include <cstdio>

#include "protocol/json.h"
#include "protocol/messages.h"
#include "util/host_error.h"

namespace usee::recorder_host {

namespace {

void check_decode(HRESULT hr) { check_hr(hr, ErrorCategory::storage, "storage.waveform-failed"); }

std::string utc_timestamp() {
  SYSTEMTIME now{};
  GetSystemTime(&now);
  char buffer[32]{};
  std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", now.wYear,
                now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds);
  return buffer;
}

void write_file_durably(const std::filesystem::path& path, const std::string& contents) {
  const winrt::file_handle file{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                            FILE_ATTRIBUTE_NORMAL, nullptr)};
  DWORD written = 0;
  if (!file ||
      !WriteFile(file.get(), contents.data(), static_cast<DWORD>(contents.size()), &written,
                 nullptr) ||
      written != contents.size() || !FlushFileBuffers(file.get())) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::storage, "storage.waveform-failed");
  }
}

}  // namespace

PeakAccumulator::PeakAccumulator(unsigned sample_rate, unsigned channels, unsigned peaks_per_second)
    : frames_per_peak_(std::max(1u, sample_rate / peaks_per_second)), channels_(channels) {}

void PeakAccumulator::add(const std::int16_t* samples, std::uint32_t frames) {
  for (std::uint32_t frame = 0; frame < frames; ++frame) {
    for (unsigned channel = 0; channel < channels_; ++channel) {
      const int value = samples[static_cast<size_t>(frame) * channels_ + channel];
      bucket_peak_ = std::max(bucket_peak_, value < 0 ? -value : value);
    }
    if (++frames_in_bucket_ == frames_per_peak_) {
      close_bucket();
    }
  }
}

void PeakAccumulator::add_silence(std::int64_t frames) {
  while (frames > 0) {
    const std::int64_t count =
        std::min<std::int64_t>(frames, frames_per_peak_ - frames_in_bucket_);
    frames_in_bucket_ += static_cast<std::uint32_t>(count);
    frames -= count;
    if (frames_in_bucket_ == frames_per_peak_) {
      close_bucket();
    }
  }
}

std::vector<std::uint8_t> PeakAccumulator::finish() {
  if (frames_in_bucket_ > 0) {
    close_bucket();
  }
  return std::move(peaks_);
}

void PeakAccumulator::close_bucket() {
  peaks_.push_back(static_cast<std::uint8_t>(std::min(255, (bucket_peak_ * 255 + 16'383) / 32'767)));
  bucket_peak_ = 0;
  frames_in_bucket_ = 0;
}

std::string base64_encode(const std::vector<std::uint8_t>& bytes) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string text;
  text.reserve((bytes.size() + 2) / 3 * 4);
  for (size_t index = 0; index < bytes.size(); index += 3) {
    const size_t remaining = bytes.size() - index;
    const std::uint32_t chunk = (static_cast<std::uint32_t>(bytes[index]) << 16) |
                                (remaining > 1 ? static_cast<std::uint32_t>(bytes[index + 1]) << 8 : 0) |
                                (remaining > 2 ? static_cast<std::uint32_t>(bytes[index + 2]) : 0);
    text.push_back(kAlphabet[(chunk >> 18) & 0x3F]);
    text.push_back(kAlphabet[(chunk >> 12) & 0x3F]);
    text.push_back(remaining > 1 ? kAlphabet[(chunk >> 6) & 0x3F] : '=');
    text.push_back(remaining > 2 ? kAlphabet[chunk & 0x3F] : '=');
  }
  return text;
}

WaveformInfo write_waveform(const std::filesystem::path& media, std::string_view media_sha256) {
  const auto stream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM);
  winrt::com_ptr<IMFSourceReader> reader;
  check_decode(MFCreateSourceReaderFromURL(media.c_str(), nullptr, reader.put()));
  check_decode(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE));
  check_decode(reader->SetStreamSelection(stream, TRUE));

  // Asking for 16-bit PCM makes the reader load the AAC decoder.
  winrt::com_ptr<IMFMediaType> pcm;
  check_decode(MFCreateMediaType(pcm.put()));
  check_decode(pcm->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio));
  check_decode(pcm->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM));
  check_decode(pcm->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16));
  check_decode(reader->SetCurrentMediaType(stream, nullptr, pcm.get()));
  winrt::com_ptr<IMFMediaType> decoded;
  check_decode(reader->GetCurrentMediaType(stream, decoded.put()));
  UINT32 rate = 0;
  UINT32 channels = 0;
  check_decode(decoded->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate));
  check_decode(decoded->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels));
  if (rate == 0 || channels == 0) {
    throw HostError(ErrorCategory::storage, "storage.waveform-failed", false);
  }

  PeakAccumulator accumulator(rate, channels, kWaveformPeaksPerSecond);
  const std::int64_t bucket_frames = rate / kWaveformPeaksPerSecond;
  std::int64_t position = 0;
  for (;;) {
    DWORD flags = 0;
    LONGLONG timestamp = 0;
    winrt::com_ptr<IMFSample> sample;
    check_decode(reader->ReadSample(stream, 0, nullptr, &flags, &timestamp, sample.put()));
    if ((flags & (MF_SOURCE_READERF_ENDOFSTREAM | MF_SOURCE_READERF_ERROR)) != 0) {
      break;
    }
    if (!sample) {
      continue;
    }
    // Silence covers a gap before this sample, so peaks stay on the clock.
    const std::int64_t at = (timestamp * rate + 5'000'000) / 10'000'000;
    if (at - position > bucket_frames / 2) {
      accumulator.add_silence(at - position);
      position = at;
    }
    winrt::com_ptr<IMFMediaBuffer> buffer;
    check_decode(sample->ConvertToContiguousBuffer(buffer.put()));
    BYTE* data = nullptr;
    DWORD length = 0;
    check_decode(buffer->Lock(&data, nullptr, &length));
    const auto frames = static_cast<std::uint32_t>(length / (2 * channels));
    accumulator.add(reinterpret_cast<const std::int16_t*>(data), frames);
    buffer->Unlock();
    position += frames;
  }
  const std::vector<std::uint8_t> peaks = accumulator.finish();

  json::JsonObject document;
  json::set_string(document, L"format", "usee.waveform");
  json::set_int(document, L"version", 1);
  json::set_string(document, L"producer", "recorder-host " + std::string(kHostVersion));
  json::set_string(document, L"algorithm", "peak-abs-u8");
  json::set_string(document, L"inputSha256", media_sha256);
  json::set_int(document, L"sampleRateHz", rate);
  json::set_int(document, L"peaksPerSecond", kWaveformPeaksPerSecond);
  json::set_int(document, L"peakCount", static_cast<std::int64_t>(peaks.size()));
  json::set_string(document, L"generatedAt", utc_timestamp());
  json::set_string(document, L"peaks", base64_encode(peaks));

  const auto directory = media.parent_path();
  const auto partial = directory / kWaveformPartialFileName;
  write_file_durably(partial, json::stringify(document));
  if (!MoveFileExW(partial.c_str(), (directory / kWaveformFileName).c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    const HRESULT hr = HRESULT_FROM_WIN32(GetLastError());
    std::error_code ignored;
    std::filesystem::remove(partial, ignored);
    check_hr(hr, ErrorCategory::storage, "storage.waveform-failed");
  }
  return {static_cast<std::int64_t>(peaks.size()), kWaveformPeaksPerSecond};
}

}  // namespace usee::recorder_host
