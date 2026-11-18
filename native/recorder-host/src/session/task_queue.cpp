#include "pch.h"

#include "session/task_queue.h"

#include "util/log.h"

namespace usee::recorder_host {

TaskQueue::TaskQueue() : thread_([this] { run(); }) {}

TaskQueue::~TaskQueue() {
  {
    std::lock_guard lock(mutex_);
    stopping_ = true;
  }
  changed_.notify_all();
  thread_.join();
}

void TaskQueue::post(std::function<void()> task) {
  {
    std::lock_guard lock(mutex_);
    tasks_.push_back(std::move(task));
  }
  changed_.notify_all();
}

void TaskQueue::drain() {
  std::unique_lock lock(mutex_);
  changed_.wait(lock, [this] { return tasks_.empty() && !busy_; });
}

void TaskQueue::run() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  std::unique_lock lock(mutex_);
  while (true) {
    changed_.wait(lock, [this] { return stopping_ || !tasks_.empty(); });
    if (tasks_.empty()) {
      break;
    }
    auto task = std::move(tasks_.front());
    tasks_.pop_front();
    busy_ = true;
    lock.unlock();
    try {
      task();
    } catch (...) {
      log_event(LogLevel::error, "host.task.failed");
    }
    lock.lock();
    busy_ = false;
    changed_.notify_all();
  }
  CoUninitialize();
}

}  // namespace usee::recorder_host
