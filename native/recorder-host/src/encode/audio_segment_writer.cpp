#include "pch.h"

#include "encode/audio_segment_writer.h"

#include "util/host_error.h"

namespace usee::recorder_host {

namespace {

void check_encoding(HRESULT hr, const char* code) { check_hr(hr, ErrorCategory::encoding, code); }

}  // namespace

AudioSegmentWriter::AudioSegmentWriter(const std::filesystem::path& path, IMFMediaType* aac_type)
    : path_(path) {
  winrt::com_ptr<IMFAttributes> attributes;
  check_encoding(MFCreateAttributes(attributes.put(), 1), "encoding.writer-failed");
  check_encoding(attributes->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4),
                 "encoding.writer-failed");
  check_hr(MFCreateSinkWriterFromURL(path.c_str(), nullptr, attributes.get(), writer_.put()),
           ErrorCategory::storage, "storage.segment-create-failed");

  // Input and output types are the same compressed type, so the writer only muxes.
  check_encoding(writer_->AddStream(aac_type, &stream_), "encoding.encoder-unavailable");
  check_encoding(writer_->SetInputMediaType(stream_, aac_type, nullptr),
                 "encoding.encoder-unavailable");
  check_encoding(writer_->BeginWriting(), "encoding.encoder-unavailable");
}

AudioSegmentWriter::~AudioSegmentWriter() = default;

void AudioSegmentWriter::write(IMFSample* frame, std::int64_t time_hns, std::int64_t duration_hns) {
  check_encoding(frame->SetSampleTime(time_hns), "encoding.write-failed");
  check_encoding(frame->SetSampleDuration(duration_hns), "encoding.write-failed");
  check_encoding(writer_->WriteSample(stream_, frame), "encoding.write-failed");
}

void AudioSegmentWriter::finalize() {
  if (finalized_) {
    return;
  }
  finalized_ = true;
  check_hr(writer_->Finalize(), ErrorCategory::storage, "storage.segment-finalize-failed");
  writer_ = nullptr;
}

}  // namespace usee::recorder_host
