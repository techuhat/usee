#include "pch.h"

#include "encode/video_segment_writer.h"

#include "util/host_error.h"
#include "util/utf.h"

namespace usee::recorder_host {

namespace {

void check_encoding(HRESULT hr, const char* code) { check_hr(hr, ErrorCategory::encoding, code); }

winrt::com_ptr<IMFMediaType> video_type(const GUID& subtype, const VideoFormat& format) {
  winrt::com_ptr<IMFMediaType> type;
  check_encoding(MFCreateMediaType(type.put()), "encoding.media-type-failed");
  check_encoding(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "encoding.media-type-failed");
  check_encoding(type->SetGUID(MF_MT_SUBTYPE, subtype), "encoding.media-type-failed");
  check_encoding(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive),
                 "encoding.media-type-failed");
  check_encoding(MFSetAttributeSize(type.get(), MF_MT_FRAME_SIZE, format.size.width,
                                    format.size.height),
                 "encoding.media-type-failed");
  check_encoding(MFSetAttributeRatio(type.get(), MF_MT_FRAME_RATE,
                                     static_cast<UINT32>(format.fps_numerator),
                                     static_cast<UINT32>(format.fps_denominator)),
                 "encoding.media-type-failed");
  check_encoding(MFSetAttributeRatio(type.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
                 "encoding.media-type-failed");
  return type;
}

void set_codec_value(ICodecAPI* codec, const GUID& property, UINT32 value) {
  VARIANT variant{};
  variant.vt = VT_UI4;
  variant.ulVal = value;
  // Optional tuning; encoders that do not support a property keep their default.
  codec->SetValue(&property, &variant);
}

}  // namespace

unsigned default_bitrate(FrameSize size, std::int64_t fps_numerator, std::int64_t fps_denominator) {
  const double fps = static_cast<double>(fps_numerator) / static_cast<double>(fps_denominator);
  const double bits = static_cast<double>(size.width) * size.height * fps * 0.1;
  return static_cast<unsigned>(std::clamp(bits, 2'000'000.0, 40'000'000.0));
}

VideoSegmentWriter::VideoSegmentWriter(const std::filesystem::path& path,
                                       const VideoFormat& format, const D3DContext& d3d,
                                       VideoInputMode mode)
    : path_(path), format_(format), mode_(mode), device_(d3d.device), context_(d3d.context) {
  winrt::com_ptr<IMFAttributes> attributes;
  check_encoding(MFCreateAttributes(attributes.put(), 4), "encoding.writer-failed");
  check_encoding(attributes->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4),
                 "encoding.writer-failed");
  check_encoding(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
                                       mode == VideoInputMode::gpu ? TRUE : FALSE),
                 "encoding.writer-failed");
  if (mode == VideoInputMode::gpu) {
    check_encoding(attributes->SetUnknown(MF_SINK_WRITER_D3D_MANAGER, d3d.device_manager.get()),
                   "encoding.writer-failed");
  }

  check_hr(MFCreateSinkWriterFromURL(path.c_str(), nullptr, attributes.get(), writer_.put()),
           ErrorCategory::storage, "storage.segment-create-failed");

  auto output = video_type(MFVideoFormat_H264, format);
  check_encoding(output->SetUINT32(MF_MT_AVG_BITRATE, format.bitrate), "encoding.media-type-failed");
  check_encoding(output->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High),
                 "encoding.media-type-failed");
  check_encoding(writer_->AddStream(output.get(), &stream_), "encoding.encoder-unavailable");

  // BGRA8 is RGB32 in Media Foundation terms; a positive stride means top-down rows.
  auto input = video_type(MFVideoFormat_RGB32, format);
  check_encoding(input->SetUINT32(MF_MT_DEFAULT_STRIDE, format.size.width * 4),
                 "encoding.media-type-failed");
  check_encoding(writer_->SetInputMediaType(stream_, input.get(), nullptr),
                 "encoding.encoder-unavailable");

  winrt::com_ptr<ICodecAPI> codec;
  if (SUCCEEDED(writer_->GetServiceForStream(stream_, GUID_NULL, __uuidof(ICodecAPI),
                                             codec.put_void()))) {
    set_codec_value(codec.get(), CODECAPI_AVEncMPVGOPSize, format.gop_frames);
  }

  check_encoding(writer_->BeginWriting(), "encoding.encoder-unavailable");
  detect_encoder();

  if (mode == VideoInputMode::cpu_software) {
    D3D11_TEXTURE2D_DESC description{};
    description.Width = format.size.width;
    description.Height = format.size.height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_STAGING;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    check_hr(device_->CreateTexture2D(&description, nullptr, staging_.put()),
             ErrorCategory::capture, "capture.out-of-video-memory", true);
  }
}

VideoSegmentWriter::~VideoSegmentWriter() {
  if (!finalized_ && writer_) {
    // An unfinalized writer leaves an unplayable file; the caller removes it.
    writer_ = nullptr;
  }
}

void VideoSegmentWriter::detect_encoder() {
  encoder_ = {"H.264 encoder", false, mode_ == VideoInputMode::gpu};
  const auto extended = writer_.try_as<IMFSinkWriterEx>();
  if (!extended) {
    return;
  }
  for (DWORD index = 0;; ++index) {
    GUID category{};
    winrt::com_ptr<IMFTransform> transform;
    if (FAILED(extended->GetTransformForStream(stream_, index, &category, transform.put()))) {
      break;
    }
    if (category != MFT_CATEGORY_VIDEO_ENCODER) {
      continue;
    }
    winrt::com_ptr<IMFAttributes> attributes;
    if (FAILED(transform->GetAttributes(attributes.put())) || !attributes) {
      break;
    }
    UINT32 length = 0;
    encoder_.hardware =
        SUCCEEDED(attributes->GetStringLength(MFT_ENUM_HARDWARE_URL_Attribute, &length));
    std::wstring name(256, L'\0');
    if (SUCCEEDED(attributes->GetString(MFT_FRIENDLY_NAME_Attribute, name.data(),
                                        static_cast<UINT32>(name.size()), &length))) {
      name.resize(length);
      encoder_.name = to_utf8(name);
    } else {
      encoder_.name = encoder_.hardware ? "Hardware H.264 encoder" : "Microsoft H.264 encoder";
    }
    break;
  }
}

void VideoSegmentWriter::write(IMFSample* sample, ID3D11Texture2D* texture, std::int64_t time_hns,
                               std::int64_t duration_hns) {
  if (mode_ == VideoInputMode::cpu_software) {
    write_cpu(texture, time_hns, duration_hns);
    return;
  }
  check_encoding(sample->SetSampleTime(time_hns), "encoding.write-failed");
  check_encoding(sample->SetSampleDuration(duration_hns), "encoding.write-failed");
  check_encoding(writer_->WriteSample(stream_, sample), "encoding.write-failed");
}

void VideoSegmentWriter::write_cpu(ID3D11Texture2D* texture, std::int64_t time_hns,
                                   std::int64_t duration_hns) {
  context_->CopyResource(staging_.get(), texture);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  check_hr(context_->Map(staging_.get(), 0, D3D11_MAP_READ, 0, &mapped), ErrorCategory::capture,
           "capture.readback-failed");

  const DWORD row_bytes = format_.size.width * 4;
  const DWORD total_bytes = row_bytes * format_.size.height;
  winrt::com_ptr<IMFMediaBuffer> buffer;
  HRESULT hr = MFCreateMemoryBuffer(total_bytes, buffer.put());
  BYTE* destination = nullptr;
  if (SUCCEEDED(hr)) {
    hr = buffer->Lock(&destination, nullptr, nullptr);
  }
  if (SUCCEEDED(hr)) {
    hr = MFCopyImage(destination, static_cast<LONG>(row_bytes),
                     static_cast<const BYTE*>(mapped.pData), static_cast<LONG>(mapped.RowPitch),
                     row_bytes, format_.size.height);
    buffer->Unlock();
  }
  context_->Unmap(staging_.get(), 0);
  check_encoding(hr, "encoding.write-failed");
  check_encoding(buffer->SetCurrentLength(total_bytes), "encoding.write-failed");

  winrt::com_ptr<IMFSample> cpu_sample;
  check_encoding(MFCreateSample(cpu_sample.put()), "encoding.write-failed");
  check_encoding(cpu_sample->AddBuffer(buffer.get()), "encoding.write-failed");
  check_encoding(cpu_sample->SetSampleTime(time_hns), "encoding.write-failed");
  check_encoding(cpu_sample->SetSampleDuration(duration_hns), "encoding.write-failed");
  check_encoding(writer_->WriteSample(stream_, cpu_sample.get()), "encoding.write-failed");
}

void VideoSegmentWriter::finalize() {
  if (finalized_) {
    return;
  }
  finalized_ = true;
  check_hr(writer_->Finalize(), ErrorCategory::storage, "storage.segment-finalize-failed");
  writer_ = nullptr;
}

}  // namespace usee::recorder_host
