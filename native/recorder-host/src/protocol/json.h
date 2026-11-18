#pragma once

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

#include <winrt/Windows.Data.Json.h>

namespace usee::recorder_host::json {

using winrt::Windows::Data::Json::JsonArray;
using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonValue;
using winrt::Windows::Data::Json::JsonValueType;

// Largest integer a JSON number (an IEEE double) carries exactly.
inline constexpr std::int64_t kMaxSafeInteger = 9'007'199'254'740'991;

// A request parameter that is missing, mistyped or out of range. Answered with
// a `native.invalid-params` error response; the connection stays open.
class InvalidParams : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// Parses a UTF-8 JSON object; returns nullopt for anything else.
std::optional<JsonObject> parse_object(std::string_view utf8);
std::string stringify(const JsonObject& object);

std::string require_string(const JsonObject& object, std::wstring_view key, size_t max_length);
// Missing or null yields nullopt.
std::optional<std::string> optional_string(const JsonObject& object, std::wstring_view key,
                                           size_t max_length);
bool require_bool(const JsonObject& object, std::wstring_view key);
std::int64_t require_integer(const JsonObject& object, std::wstring_view key, std::int64_t min,
                             std::int64_t max);
JsonObject require_object(const JsonObject& object, std::wstring_view key);

void set_string(JsonObject& object, std::wstring_view key, std::string_view value);
void set_bool(JsonObject& object, std::wstring_view key, bool value);
// Throws std::out_of_range beyond +/- kMaxSafeInteger.
void set_int(JsonObject& object, std::wstring_view key, std::int64_t value);
void set_null(JsonObject& object, std::wstring_view key);
void set_object(JsonObject& object, std::wstring_view key, const JsonObject& value);
void set_array(JsonObject& object, std::wstring_view key, const JsonArray& value);

}  // namespace usee::recorder_host::json
