#include "pch.h"

#include "util/sha256.h"

#include "util/host_error.h"

namespace usee::recorder_host {

namespace {

void check_status(NTSTATUS status) {
  if (!BCRYPT_SUCCESS(status)) {
    throw HostError(ErrorCategory::storage, "storage.hash-failed", false,
                    format_hresult(static_cast<long>(status)));
  }
}

}  // namespace

FileDigest hash_file(const std::filesystem::path& path) {
  const winrt::file_handle file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                            OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr)};
  if (!file) {
    check_hr(HRESULT_FROM_WIN32(GetLastError()), ErrorCategory::storage, "storage.read-failed");
  }

  BCRYPT_ALG_HANDLE algorithm = nullptr;
  check_status(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
  BCRYPT_HASH_HANDLE hash = nullptr;
  const auto cleanup = [&] {
    if (hash != nullptr) {
      BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(algorithm, 0);
  };

  FileDigest digest;
  try {
    check_status(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0));
    std::vector<unsigned char> buffer(1 << 20);
    DWORD read = 0;
    while (ReadFile(file.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) &&
           read > 0) {
      check_status(BCryptHashData(hash, buffer.data(), read, 0));
      digest.bytes += read;
    }
    std::array<unsigned char, 32> value{};
    check_status(BCryptFinishHash(hash, value.data(), static_cast<ULONG>(value.size()), 0));

    static constexpr char kHex[] = "0123456789abcdef";
    digest.sha256_hex.reserve(64);
    for (const unsigned char byte : value) {
      digest.sha256_hex.push_back(kHex[byte >> 4]);
      digest.sha256_hex.push_back(kHex[byte & 0x0F]);
    }
  } catch (...) {
    cleanup();
    throw;
  }
  cleanup();
  return digest;
}

}  // namespace usee::recorder_host
