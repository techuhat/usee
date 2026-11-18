#pragma once

#include <filesystem>
#include <string>

#include "capture/d3d_context.h"
#include "capture/frame_source.h"

namespace usee::recorder_host {

struct VideoFormat {
  FrameSize size;
  std::int64_t fps_numerator = 60;
  std::int64_t fps_denominator = 1;
  unsigned bitrate = 0;
  unsigned gop_frames = 120;
};

struct EncoderInfo {
  std::string name;
  bool hardware = false;
  bool gpu_input = false;
};

// How samples reach the encoder.
enum class VideoInputMode {
  // D3D11 textures through the DXGI device manager; hardware MFTs allowed.
  gpu,
  // CPU read-back into system memory with hardware MFTs disabled: the
  // mandatory software fallback (docs/recording-pipeline.md).
  cpu_software,
};

// One H.264 MP4 segment written with IMFSinkWriter. Each segment is a new
// writer, so it starts with a keyframe and is playable on its own.
class VideoSegmentWriter {
 public:
  VideoSegmentWriter(const std::filesystem::path& path, const VideoFormat& format,
                     const D3DContext& d3d, VideoInputMode mode);
  ~VideoSegmentWriter();

  VideoSegmentWriter(const VideoSegmentWriter&) = delete;
  VideoSegmentWriter& operator=(const VideoSegmentWriter&) = delete;

  // GPU mode: `sample` wraps `texture`. CPU mode: `texture` is read back and
  // `sample` is ignored.
  void write(IMFSample* sample, ID3D11Texture2D* texture, std::int64_t time_hns,
             std::int64_t duration_hns);
  void finalize();

  const EncoderInfo& encoder() const noexcept { return encoder_; }
  VideoInputMode mode() const noexcept { return mode_; }
  const std::filesystem::path& path() const noexcept { return path_; }

 private:
  void write_cpu(ID3D11Texture2D* texture, std::int64_t time_hns, std::int64_t duration_hns);
  void detect_encoder();

  std::filesystem::path path_;
  VideoFormat format_;
  VideoInputMode mode_;
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext> context_;
  winrt::com_ptr<ID3D11Texture2D> staging_;
  winrt::com_ptr<IMFSinkWriter> writer_;
  DWORD stream_ = 0;
  EncoderInfo encoder_;
  bool finalized_ = false;
};

// Bitrate heuristic for screen content: 0.1 bits per pixel per frame,
// clamped to 2-40 Mbps (about 12.4 Mbps at 1080p/60).
unsigned default_bitrate(FrameSize size, std::int64_t fps_numerator, std::int64_t fps_denominator);

}  // namespace usee::recorder_host
