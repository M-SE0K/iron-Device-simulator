// ring_buffer.h — 락프리 SPSC(단일 생산자 / 단일 소비자) 바이트 링버퍼.
//
// 생산자는 ASIO의 실시간 스레드(bufferSwitch)다. 여기서는 절대 블로킹하면 안 된다 —
// stdout 파이프가 차 있을 때 fwrite를 직접 하면 그대로 드롭아웃이 된다. 그래서
// RT 스레드는 이 링에 논블로킹으로 밀어 넣기만 하고, 별도 writer 스레드가 꺼내
// 느긋하게 fwrite한다. (CAPTURE-PLAN.md §2)
//
// 뮤텍스를 쓰지 않는 이유는 성능이 아니라 **우선순위 역전** 때문이다. RT 스레드가
// 일반 스레드가 쥔 락을 기다리면 오디오가 끊긴다.
//
// 설계상 중요한 성질 두 가지:
//
//  1. **전부-아니면-전무 쓰기.** 공간이 부족하면 블록 전체를 버린다. 부분 쓰기를
//     허용하면 인터리브 프레임 경계가 깨져서, 이후 모든 샘플의 채널이 한 칸씩
//     밀린 채로 영구히 어긋난다. 잠깐 끊기는 건 복구되지만 채널이 밀리는 건 안 된다.
//  2. **인덱스는 단조 증가.** 래핑된 인덱스를 쓰면 "가득 참"과 "빔"이 구분되지 않아
//     한 칸을 낭비하거나 플래그가 필요해진다. 접근할 때만 마스킹한다.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>

class RingBuffer {
 public:
  // capacity는 2의 거듭제곱으로 올림된다(마스킹으로 래핑하기 위해).
  explicit RingBuffer(size_t capacity) {
    size_t cap = 1;
    while (cap < capacity) cap <<= 1;
    cap_ = cap;
    mask_ = cap - 1;
    buf_.reset(new uint8_t[cap_]);
  }

  size_t capacity() const { return cap_; }

  // --- 생산자(RT 스레드) 전용 --------------------------------------------
  // 공간이 부족하면 아무것도 쓰지 않고 false를 돌려주며 드롭 카운터만 올린다.
  // RT 컨텍스트이므로 로그를 쓰거나 대기하지 않는다.
  bool write(const void* data, size_t n) {
    const size_t head = head_.load(std::memory_order_relaxed);  // 생산자만 갱신
    const size_t tail = tail_.load(std::memory_order_acquire);  // 소비자가 갱신
    if (cap_ - (head - tail) < n) {
      dropped_.fetch_add(n, std::memory_order_relaxed);
      return false;
    }

    const size_t off = head & mask_;
    const size_t first = (cap_ - off < n) ? cap_ - off : n;  // 끝에서 잘리는 만큼
    memcpy(buf_.get() + off, data, first);
    if (first < n) memcpy(buf_.get(), static_cast<const uint8_t*>(data) + first, n - first);

    // release: 위 memcpy가 소비자에게 보이도록 보장한 뒤 head를 공개한다
    head_.store(head + n, std::memory_order_release);
    return true;
  }

  // --- 소비자(writer 스레드) 전용 ----------------------------------------
  // 있는 만큼만 읽어 실제로 읽은 바이트 수를 돌려준다. 0이면 비어 있다.
  size_t read(void* out, size_t maxN) {
    const size_t tail = tail_.load(std::memory_order_relaxed);  // 소비자만 갱신
    const size_t head = head_.load(std::memory_order_acquire);  // 생산자가 갱신
    const size_t avail = head - tail;
    const size_t n = avail < maxN ? avail : maxN;
    if (n == 0) return 0;

    const size_t off = tail & mask_;
    const size_t first = (cap_ - off < n) ? cap_ - off : n;
    memcpy(out, buf_.get() + off, first);
    if (first < n) memcpy(static_cast<uint8_t*>(out) + first, buf_.get(), n - first);

    tail_.store(tail + n, std::memory_order_release);
    return n;
  }

  // --- 양쪽에서 조회 가능 -------------------------------------------------
  size_t available() const {
    return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire);
  }

  // write()가 **거절한** 누적 바이트 수. RT 생산자는 재시도하지 않으므로 이 값이 곧
  // 유실된 오디오량이다. (호출 측이 재시도하면 같은 데이터가 중복 계수되므로 그때는
  // 유실량이 아니다 — 테스트 코드가 그런 경우다.)
  // 종료 시 stderr에 남겨 드롭아웃을 진단한다.
  uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

 private:
  std::unique_ptr<uint8_t[]> buf_;
  size_t cap_ = 0;
  size_t mask_ = 0;

  // head_와 tail_을 각각 다른 캐시 라인에 둔다. 같은 라인에 있으면 두 스레드가
  // 서로의 스토어 때문에 캐시 라인을 계속 뺏어와 RT 스레드가 느려진다(false sharing).
  alignas(64) std::atomic<size_t> head_{0};
  alignas(64) std::atomic<size_t> tail_{0};
  alignas(64) std::atomic<uint64_t> dropped_{0};
};
