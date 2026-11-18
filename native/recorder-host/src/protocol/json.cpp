#include "pch.h"

#include "protocol/json.h"

#include <cmath>

#include "util/utf.h"

namespace usee::recorder_host::json {

namespace {

std::string key_text(std::wstring_view key) { return to_utf8(key); }

JsonValue named_value(const JsonObject& object, std::wstring_view key) {
  const winrt::hstring name{key};
  if (!object.HasKey(name)) {
    throw InvalidParams("Missing parameter \"" + key_text(key) + "\".");
  }
  return object.GetNamedValue(name);
}

}  // namespace

std::optional<JsonObject> parse_object(std::string_view utf8) {
  std::wstring text;
  try {
    text = to_wide(utf8);
  } catch (const std::invalid_argument&) {
    return std::nullopt;
  }
  JsonObject object{nullptr};
  if (!JsonObject::TryParse(winrt::hstring{text}, object)) {
    return std::nullopt;
  }
  return object;
}

std::string stringify(const JsonObject& object) { return to_utf8(object.Stringify()); }

std::string require_string(const JsonObject& object, std::wstring_view key, size_t max_length) {
  const JsonValue value = named_value(object, key);
  if (value.ValueType() != JsonValueType::String) {
    throw InvalidParams("Parameter \"" + key_text(key) + "\" must be a string.");
  }
  std::string text = to_utf8(value.GetString());
  if (text.empty() || text.size() > max_length) {
    throw InvalidParams("Parameter \"" + key_text(key) + "\" has an invalid length.");
  }
  return text;
}

std::optional<std::string> optional_string(const JsonObject& object, std::wstring_view key,
                                           size_t max_length) {
  const winrt::hstring name{key};
  if (!object.HasKey(name) || object.GetNamedValue(name).ValueType() == JsonValueType::Null) {
    return std::nullopt;
  }
  return require_string(object, key, max_length);
}

bool require_bool(const JsonObject& object, std::wstring_view key) {
  const JsonValue value = named_value(object, key);
  if (value.ValueType() != JsonValueType::Boolean) {
    throw InvalidParams("Parameter \"" + key_text(key) + "\" must be a boolean.");
  }
  return value.GetBoolean();
}

std::int64_t require_integer(const JsonObject& object, std::wstring_view key, std::int64_t min,
                             std::int64_t max) {
  const JsonValue value = named_value(object, key);
  if (value.ValueType() != JsonValueType::Number) {
    throw InvalidParams("Parameter \"" + key_text(key) + "\" must be a number.");
  }
  const double number = value.GetNumber();
  if (!std::isfinite(number) || std::floor(number) != number ||
      number < static_cast<double>(min) || number > static_cast<double>(max)) {
    throw InvalidParams("Parameter \"" + key_text(key) + "\" is out of range.");
  }
  return static_cast<std::int64_t>(number);
}

JsonObject require_object(const JsonObject& object, std::wstring_view key) {
  const JsonValue value = named_value(object, key);
  if (value.ValueType() != JsonValueType::Object) {
    throw InvalidParams("Parameter \"" + key_text(key) + "\" must be an object.");
  }
  return value.GetObject();
}

void set_string(JsonObject& object, std::wstring_view key, std::string_view value) {
  object.SetNamedValue(winrt::hstring{key}, JsonValue::CreateStringValue(to_wide(value)));
}

void set_bool(JsonObject& object, std::wstring_view key, bool value) {
  object.SetNamedValue(winrt::hstring{key}, JsonValue::CreateBooleanValue(value));
}

void set_int(JsonObject& object, std::wstring_view key, std::int64_t value) {
  if (value > kMaxSafeInteger || value < -kMaxSafeInteger) {
    throw std::out_of_range("Integer is not exactly representable in JSON.");
  }
  object.SetNamedValue(winrt::hstring{key},
                       JsonValue::CreateNumberValue(static_cast<double>(value)));
}

void set_null(JsonObject& object, std::wstring_view key) {
  object.SetNamedValue(winrt::hstring{key}, JsonValue::CreateNullValue());
}

void set_object(JsonObject& object, std::wstring_view key, const JsonObject& value) {
  object.SetNamedValue(winrt::hstring{key}, value);
}

void set_array(JsonObject& object, std::wstring_view key, const JsonArray& value) {
  object.SetNamedValue(winrt::hstring{key}, value);
}

}  // namespace usee::recorder_host::json
