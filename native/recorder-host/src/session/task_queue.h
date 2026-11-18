#pragma once

#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>

namespace usee::recorder_host {

// A single worker thread for slow, ordered work off the real-time threads:
// finalizing segments, hashing them, preparing the next encoder.
class TaskQueue {
 public:
  TaskQueue();
  ~TaskQueue();

  TaskQueue(const TaskQueue&) = delete;
  TaskQueue& operator=(const TaskQueue&) = delete;

  void post(std::function<void()> task);

  // Blocks until every posted task has run.
  void drain();

 private:
  void run();

  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<std::function<void()>> tasks_;
  bool busy_ = false;
  bool stopping_ = false;
  std::thread thread_;
};

}  // namespace usee::recorder_host
