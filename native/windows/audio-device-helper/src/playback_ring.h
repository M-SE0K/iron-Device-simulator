// playback_ring.h — play-capture --stream 전용 재생 링버퍼 (락프리 SPSC).
//
// 생산자는 stdin 리더 스레드(렌더러가 밀어 넣는 보호 PCM), 소비자는 ASIO의 실시간
// 스레드(bufferSwitch)다. 방향만 반대일 뿐 ring_buffer.h와 같은 이유로 뮤텍스를 쓰지
// 않는다 — RT 스레드가 일반 스레드의 락을 기다리면 그대로 드롭아웃이다.
// (macOS 헬퍼의 PlaybackRing은 os_unfair_lock을 쓰지만, 여기서는 SPSC가 보장되므로
//  락 없이 같은 의미론을 얻는다.)
//
// ring_buffer.h와 다른 설계 결정 두 가지 — 방향이 반대라서 정반대가 되는 것들이다:
//
//  1. **부분 쓰기를 허용한다.** 캡처 링은 공간이 없으면 블록을 통째로 버리지만(채널 정렬
//     보존), 여기서는 버리면 안 된다. 재생 샘플은 하나도 잃을 수 없으므로(보호 신호다)
//     들어가는 만큼만 넣고 실제 적재량을 돌려준다. 호출자가 남은 만큼 재시도하는 것이
//     곧 파이프를 거슬러 렌더러까지 닿는 백프레셔다. 프레임 단위로만 적재하므로 부분
//     쓰기가 L/R 정렬을 깨지 않는다.
//  2. **언더런 때 읽기 위치를 소비하지 않는다.** 있는 만큼만 읽어가고 모자란 만큼은
//     호출자가 무음으로 메운다 — 샘플을 버리는 게 아니라 뒤로 미루는 것이다.
//     "입력 PCM 프레임을 드롭·스킵·재정렬하지 않는다"는 프로젝트 규약과 같은 선택
//     (docs/protected-playback-plan.md D5).
//
// 저장은 **평면(planar)** L/R이다. 인터리브로 들고 있으면 RT 스레드가 매 콜백 풀어야
// 하는데, ASIO 출력 버퍼도 어차피 채널당 분리이고 convert::fromFloat도 연속 mono를
// 받는다 — 인터리브 해제는 stdin 스레드에서 한 번만 하는 편이 RT 예산에 이롭다.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>

class PlaybackRing {
 public:
  // capacityFrames는 2의 거듭제곱으로 올림된다(마스킹으로 래핑하기 위해).
  explicit PlaybackRing(size_t capacityFrames) {
    size_t cap = 1;
    while (cap < capacityFrames) cap <<= 1;
    cap_ = cap;
    mask_ = cap - 1;
    l_.reset(new float[cap_]());
    r_.reset(new float[cap_]());
  }

  size_t capacityFrames() const { return cap_; }

  // --- 생산자(stdin 리더 스레드) 전용 ------------------------------------
  //
  // 인터리브 스테레오 int16을 float [-1,1] 평면으로 풀어 적재한다. src는
  // [L0,R0,L1,R1,...] 이고 fromFrame번째 프레임부터 최대 maxFrames개를 읽는다.
  // 반환값은 실제로 적재한 프레임 수(공간이 모자라면 요청보다 작다).
  size_t write(const int16_t* src, size_t fromFrame, size_t maxFrames) {
    const size_t head = head_.load(std::memory_order_relaxed);  // 생산자만 갱신
    const size_t tail = tail_.load(std::memory_order_acquire);  // 소비자가 갱신
    const size_t space = cap_ - (head - tail);
    const size_t n = space < maxFrames ? space : maxFrames;
    if (n == 0) return 0;

    for (size_t i = 0; i < n; ++i) {
      const size_t s = (fromFrame + i) * 2;
      const size_t d = (head + i) & mask_;
      // 32768로 나눈다 — int16 최소값(-32768)이 정확히 -1.0이 되고 클리핑이 없다.
      l_[d] = static_cast<float>(src[s]) / 32768.0f;
      r_[d] = static_cast<float>(src[s + 1]) / 32768.0f;
    }
    head_.store(head + n, std::memory_order_release);
    return n;
  }

  // 더 보낼 프레임이 없다("end" 수신). 이 시점 이후로 write()는 호출되지 않는다.
  // 반드시 마지막 write() **뒤에** 불러야 한다 — 같은 스레드라 순서는 자연히 지켜진다.
  void markEndOfStream() { atEnd_.store(true, std::memory_order_release); }

  // --- 소비자(RT 스레드) 전용 --------------------------------------------
  //
  // 최대 maxFrames를 평면 L/R로 꺼낸다. 반환값이 요청보다 작으면 그만큼은 호출자가
  // 무음으로 메워야 한다(링이 빈 상태 = 언더런 또는 재생 종료).
  size_t read(float* outL, float* outR, size_t maxFrames) {
    const size_t tail = tail_.load(std::memory_order_relaxed);  // 소비자만 갱신
    const size_t head = head_.load(std::memory_order_acquire);  // 생산자가 갱신
    const size_t avail = head - tail;
    const size_t n = avail < maxFrames ? avail : maxFrames;
    if (n == 0) return 0;

    for (size_t i = 0; i < n; ++i) {
      const size_t s = (tail + i) & mask_;
      outL[i] = l_[s];
      outR[i] = r_[s];
    }
    tail_.store(tail + n, std::memory_order_release);
    return n;
  }

  // 언더런 집계 — RT 스레드만 올리고, 종료 시 main 스레드가 stderr로 남긴다.
  void countUnderrun(size_t frames) {
    underruns_.fetch_add(frames, std::memory_order_relaxed);
  }

  // --- 양쪽에서 조회 가능 -------------------------------------------------
  size_t available() const {
    return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire);
  }
  bool endOfStream() const { return atEnd_.load(std::memory_order_acquire); }
  // 재생할 것이 더 없음 — "end"를 받았고 링까지 비었다. 이 시점부터 테일을 센다.
  bool isDrained() const { return endOfStream() && available() == 0; }
  uint64_t underrunFrames() const { return underruns_.load(std::memory_order_relaxed); }

 private:
  std::unique_ptr<float[]> l_;
  std::unique_ptr<float[]> r_;
  size_t cap_ = 0;
  size_t mask_ = 0;

  // ring_buffer.h와 같은 이유로 캐시 라인을 분리한다(false sharing 방지).
  alignas(64) std::atomic<size_t> head_{0};
  alignas(64) std::atomic<size_t> tail_{0};
  alignas(64) std::atomic<bool> atEnd_{false};
  alignas(64) std::atomic<uint64_t> underruns_{0};
};
