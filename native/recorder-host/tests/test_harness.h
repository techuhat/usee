#pragma once

// A deliberately tiny test harness: no third-party download is needed to
// build or test the host.

#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

namespace test {

struct Case {
  const char* name;
  std::function<void()> body;
};

inline std::vector<Case>& registry() {
  static std::vector<Case> cases;
  return cases;
}

struct Registrar {
  Registrar(const char* name, std::function<void()> body) {
    registry().push_back({name, std::move(body)});
  }
};

struct Failure : std::runtime_error {
  using std::runtime_error::runtime_error;
};

}  // namespace test

#define TEST_CONCAT_INNER(a, b) a##b
#define TEST_CONCAT(a, b) TEST_CONCAT_INNER(a, b)

#define TEST(name)                                                              \
  static void name();                                                           \
  static const test::Registrar TEST_CONCAT(registrar_, name){#name, &name};     \
  static void name()

#define CHECK(expression)                                                       \
  do {                                                                          \
    if (!(expression)) {                                                        \
      throw test::Failure(std::string(__FILE__) + ":" + std::to_string(__LINE__) + \
                          ": CHECK(" #expression ") failed");                   \
    }                                                                           \
  } while (false)

#define CHECK_THROWS_AS(expression, type)                                       \
  do {                                                                          \
    bool thrown = false;                                                        \
    try {                                                                       \
      (void)(expression);                                                       \
    } catch (const type&) {                                                     \
      thrown = true;                                                            \
    }                                                                           \
    if (!thrown) {                                                              \
      throw test::Failure(std::string(__FILE__) + ":" + std::to_string(__LINE__) + \
                          ": expected " #type " from " #expression);            \
    }                                                                           \
  } while (false)
