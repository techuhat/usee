#include "pch.h"

#include "protocol/messages.h"

#include "protocol/framing.h"
#include "util/utf.h"

namespace usee::recorder_host {

namespace {

bool is_method_name(std::string_view value) noexcept {
  if (value.empty() || value.size() > 32) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  });
}

std::string string_member(const json::JsonObject& object, const wchar_t* key) {
  if (!object.HasKey(key) || object.GetNamedValue(key).ValueType() != json::JsonValueType::String) {
    throw ProtocolViolation("Envelope member is missing or not a string.");
  }
  return to_utf8(object.GetNamedString(key));
}

}  // namespace

bool is_opaque_id(std::string_view value) noexcept {
  if (value.empty() || value.size() > 64) {
    return false;
  }
  const auto is_alnum = [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
  };
  if (!is_alnum(value.front())) {
    return false;
  }
  return std::all_of(value.begin(), value.end(),
                     [&](char c) { return is_alnum(c) || c == '_' || c == '-'; });
}

Request parse_request(std::string_view payload) {
  const auto object = json::parse_object(payload);
  if (!object) {
    throw ProtocolViolation("Payload is not a JSON object.");
  }
  if (string_member(*object, L"kind") != "request") {
    throw ProtocolViolation("Only requests may be sent to the host.");
  }

  Request request;
  request.id = string_member(*object, L"id");
  request.method = string_member(*object, L"method");
  if (!is_opaque_id(request.id) || !is_method_name(request.method)) {
    throw ProtocolViolation("Request id or method is malformed.");
  }
  if (!object->HasKey(L"params") ||
      object->GetNamedValue(L"params").ValueType() != json::JsonValueType::Object) {
    throw ProtocolViolation("Request params must be an object.");
  }
  request.params = object->GetNamedObject(L"params");
  return request;
}

std::string make_ok_response(std::string_view id, const json::JsonObject& result) {
  json::JsonObject envelope;
  json::set_string(envelope, L"kind", "response");
  json::set_string(envelope, L"id", id);
  json::set_bool(envelope, L"ok", true);
  json::set_object(envelope, L"result", result);
  return json::stringify(envelope);
}

std::string make_error_response(std::string_view id, const HostError& error) {
  json::JsonObject detail;
  json::set_string(detail, L"category", to_string(error.category()));
  json::set_string(detail, L"code", error.code());
  json::set_bool(detail, L"retryable", error.retryable());
  if (!error.detail().empty()) {
    json::set_string(detail, L"detail", error.detail().substr(0, 256));
  }

  json::JsonObject envelope;
  json::set_string(envelope, L"kind", "response");
  json::set_string(envelope, L"id", id);
  json::set_bool(envelope, L"ok", false);
  json::set_object(envelope, L"error", detail);
  return json::stringify(envelope);
}

std::string make_event(std::string_view name, const json::JsonObject& data) {
  json::JsonObject envelope;
  json::set_string(envelope, L"kind", "event");
  json::set_string(envelope, L"name", name);
  json::set_object(envelope, L"data", data);
  return json::stringify(envelope);
}

}  // namespace usee::recorder_host
