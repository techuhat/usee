#include "pch.h"

#include "protocol/framing.h"
#include "protocol/json.h"
#include "protocol/messages.h"
#include "test_harness.h"

using namespace usee::recorder_host;

namespace {

std::string framed(std::string_view payload) { return encode_frame(payload); }

}  // namespace

TEST(frame_round_trip_with_little_endian_length) {
  const std::string frame = framed("{}");
  CHECK(frame.size() == 6);
  CHECK(frame[0] == 2 && frame[1] == 0 && frame[2] == 0 && frame[3] == 0);
  FrameDecoder decoder;
  const auto payloads = decoder.push(frame);
  CHECK(payloads.size() == 1 && payloads[0] == "{}");
  CHECK(decoder.pending_bytes() == 0);
}

TEST(frame_decoder_handles_split_and_merged_frames) {
  const std::string stream = framed("{\"a\":1}") + framed("{\"b\":2}");
  FrameDecoder decoder;
  CHECK(decoder.push(std::string_view(stream).substr(0, 3)).empty());
  const auto first = decoder.push(std::string_view(stream).substr(3, 9));
  CHECK(first.size() == 1 && first[0] == "{\"a\":1}");
  const auto rest = decoder.push(std::string_view(stream).substr(12));
  CHECK(rest.size() == 1 && rest[0] == "{\"b\":2}");
}

TEST(frame_limits_are_enforced) {
  CHECK_THROWS_AS(encode_frame(""), ProtocolViolation);
  CHECK_THROWS_AS(encode_frame(std::string(kMaxFrameBytes + 1, 'x')), ProtocolViolation);
  CHECK(encode_frame(std::string(kMaxFrameBytes, 'x')).size() == kMaxFrameBytes + 4);

  FrameDecoder zero;
  CHECK_THROWS_AS(zero.push(std::string(4, '\0')), ProtocolViolation);

  FrameDecoder oversized;
  const std::string header{'\x01', '\x00', '\x01', '\x00'};  // 65537
  CHECK_THROWS_AS(oversized.push(header), ProtocolViolation);
}

TEST(parse_request_accepts_a_well_formed_request) {
  const Request request = parse_request(
      R"({"kind":"request","id":"req-1","method":"listDisplays","params":{}})");
  CHECK(request.id == "req-1");
  CHECK(request.method == "listDisplays");
  CHECK(request.params.Size() == 0);
}

TEST(parse_request_rejects_malformed_envelopes) {
  CHECK_THROWS_AS(parse_request("not json"), ProtocolViolation);
  CHECK_THROWS_AS(parse_request("[]"), ProtocolViolation);
  CHECK_THROWS_AS(parse_request(R"({"kind":"event","id":"a","method":"x","params":{}})"),
                  ProtocolViolation);
  CHECK_THROWS_AS(parse_request(R"({"kind":"request","id":"../x","method":"x","params":{}})"),
                  ProtocolViolation);
  CHECK_THROWS_AS(parse_request(R"({"kind":"request","id":"a","method":"x-y","params":{}})"),
                  ProtocolViolation);
  CHECK_THROWS_AS(parse_request(R"({"kind":"request","id":"a","method":"x","params":[]})"),
                  ProtocolViolation);
  CHECK_THROWS_AS(parse_request(R"({"kind":"request","id":"a","method":"x"})"),
                  ProtocolViolation);
  CHECK_THROWS_AS(parse_request("\xff\xfe"), ProtocolViolation);
}

TEST(responses_and_events_have_the_documented_shape) {
  json::JsonObject result;
  json::set_int(result, L"durationUs", 36'000'000'000);
  const auto ok = json::parse_object(make_ok_response("r1", result));
  CHECK(ok.has_value());
  CHECK(ok->GetNamedString(L"kind") == L"response");
  CHECK(ok->GetNamedBoolean(L"ok"));
  // Large integers must stay exact integers on the wire.
  CHECK(make_ok_response("r1", result).find("36000000000") != std::string::npos);

  const auto error = json::parse_object(make_error_response(
      "r2", HostError(ErrorCategory::capture, "capture.source-closed", true, "0x80070005")));
  CHECK(error.has_value());
  CHECK(!error->GetNamedBoolean(L"ok"));
  const auto detail = error->GetNamedObject(L"error");
  CHECK(detail.GetNamedString(L"category") == L"capture");
  CHECK(detail.GetNamedString(L"code") == L"capture.source-closed");
  CHECK(detail.GetNamedBoolean(L"retryable"));

  const auto event = json::parse_object(make_event("session.state", json::JsonObject{}));
  CHECK(event.has_value());
  CHECK(event->GetNamedString(L"kind") == L"event");
  CHECK(event->GetNamedString(L"name") == L"session.state");
}

TEST(parameter_helpers_validate_types_and_ranges) {
  const auto params = json::parse_object(
      R"({"name":"abc","flag":true,"count":5,"fraction":1.5,"nothing":null})");
  CHECK(params.has_value());
  CHECK(json::require_string(*params, L"name", 8) == "abc");
  CHECK(json::require_bool(*params, L"flag"));
  CHECK(json::require_integer(*params, L"count", 0, 10) == 5);
  CHECK(!json::optional_string(*params, L"nothing", 8).has_value());
  CHECK(!json::optional_string(*params, L"absent", 8).has_value());
  CHECK_THROWS_AS(json::require_string(*params, L"name", 2), json::InvalidParams);
  CHECK_THROWS_AS(json::require_integer(*params, L"fraction", 0, 10), json::InvalidParams);
  CHECK_THROWS_AS(json::require_integer(*params, L"count", 6, 10), json::InvalidParams);
  CHECK_THROWS_AS(json::require_bool(*params, L"name"), json::InvalidParams);
  CHECK_THROWS_AS(json::require_object(*params, L"absent"), json::InvalidParams);

  json::JsonObject object;
  CHECK_THROWS_AS(json::set_int(object, L"x", json::kMaxSafeInteger + 1), std::out_of_range);
}

TEST(opaque_ids_reject_path_like_values) {
  CHECK(is_opaque_id("session-01"));
  CHECK(is_opaque_id("3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90"));
  CHECK(!is_opaque_id(""));
  CHECK(!is_opaque_id("-leading"));
  CHECK(!is_opaque_id("a/b"));
  CHECK(!is_opaque_id("a\\b"));
  CHECK(!is_opaque_id(".."));
  CHECK(!is_opaque_id(std::string(65, 'a')));
}
