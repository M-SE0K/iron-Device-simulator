// test_phase1.cpp — ring_buffer.h / sample_convert.h 단위 테스트.
//
// 두 헤더 모두 Windows/ASIO 의존이 없어 WSL에서 g++로 그대로 돌아간다. 실시간 스레드와
// 포맷 변환은 실기에서 디버깅하기 가장 어려운 부분이라, 하드웨어를 붙이기 전에
// 여기서 잡는다. (CAPTURE-PLAN.md Phase 1)
//
//   ./tests/run-tests.sh
#include "../ring_buffer.h"
#include "../sample_convert.h"

#include <atomic>
#include <cstdio>
#include <thread>
#include <vector>

static int g_fail = 0;

#define CHECK(cond, ...)                                     \
  do {                                                       \
    if (!(cond)) {                                           \
      printf("  FAIL %s:%d  ", __FILE__, __LINE__);          \
      printf(__VA_ARGS__);                                   \
      printf("\n");                                          \
      ++g_fail;                                              \
    }                                                        \
  } while (0)

static void section(const char* s) { printf("\n== %s ==\n", s); }
static void ok(const char* s) { printf("  ok   %s\n", s); }

// ─────────────────────────────────────────────────────────────────────────
// RingBuffer
// ─────────────────────────────────────────────────────────────────────────

static void testRingBasic() {
  section("RingBuffer 기본");

  RingBuffer r(1024);
  CHECK(r.capacity() == 1024, "capacity=%zu", r.capacity());
  CHECK(r.available() == 0, "빈 상태여야 함");

  // 2의 거듭제곱으로 올림
  RingBuffer r2(1000);
  CHECK(r2.capacity() == 1024, "1000 → 1024로 올림되어야 함, got %zu", r2.capacity());
  ok("capacity 2의 거듭제곱 올림");

  const char* msg = "hello";
  CHECK(r.write(msg, 5), "쓰기 실패");
  CHECK(r.available() == 5, "available=%zu", r.available());

  char out[16] = {0};
  CHECK(r.read(out, sizeof(out)) == 5, "읽은 바이트 수 불일치");
  CHECK(memcmp(out, "hello", 5) == 0, "내용 불일치: %.5s", out);
  CHECK(r.available() == 0, "다 읽었으면 비어야 함");
  ok("write/read 왕복");

  CHECK(r.read(out, sizeof(out)) == 0, "빈 링에서 0이 아님");
  ok("빈 링 읽기 → 0");
}

static void testRingWrap() {
  section("RingBuffer 래핑");

  // 용량 16으로 여러 바퀴 돌려 경계를 넘나든다
  RingBuffer r(16);
  uint8_t seq = 0, expect = 0;
  uint8_t in[7], out[7];

  for (int iter = 0; iter < 100; ++iter) {
    for (auto& b : in) b = seq++;
    CHECK(r.write(in, sizeof(in)), "iter %d 쓰기 실패", iter);
    CHECK(r.read(out, sizeof(out)) == sizeof(out), "iter %d 읽기 부족", iter);
    for (auto b : out) {
      CHECK(b == expect, "iter %d 값 불일치 got=%u want=%u", iter, b, expect);
      ++expect;
    }
  }
  ok("7바이트 블록 × 100회 (용량 16 경계 반복 통과)");
}

static void testRingFullDropsWholeBlock() {
  section("RingBuffer 오버런");

  RingBuffer r(16);
  uint8_t data[10] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};

  CHECK(r.write(data, 10), "첫 쓰기 실패");
  CHECK(r.available() == 10, "available=%zu", r.available());

  // 남은 공간 6 < 10 → 전부 거절되어야 한다 (부분 쓰기 금지)
  CHECK(!r.write(data, 10), "공간 부족인데 성공했다");
  CHECK(r.available() == 10, "거절됐는데 내용이 바뀜: available=%zu", r.available());
  CHECK(r.dropped() == 10, "dropped=%llu, 10이어야 함", (unsigned long long)r.dropped());
  ok("공간 부족 → 블록 전체 드롭 (부분 쓰기 없음)");

  // 딱 맞는 크기는 들어가야 한다
  CHECK(r.write(data, 6), "정확히 남은 공간만큼 쓰기 실패");
  CHECK(r.available() == 16, "가득 차야 함: %zu", r.available());
  CHECK(!r.write(data, 1), "가득 찼는데 1바이트가 들어감");
  ok("경계값: 남은 공간 정확히 채우기 / 가득 참");
}

// 프레임 경계가 깨지지 않는지 — 부분 쓰기가 있었다면 여기서 채널이 밀린다.
static void testRingFrameIntegrityUnderDrops() {
  section("RingBuffer 드롭 시 프레임 정합성");

  RingBuffer r(64);
  const size_t frameBytes = 4;  // 2ch × int16
  size_t written = 0;

  // 일부러 넘치게 밀어 넣는다
  for (int i = 0; i < 100; ++i) {
    uint8_t frame[4] = {0xAA, 0xBB, 0xCC, 0xDD};
    if (r.write(frame, frameBytes)) written += frameBytes;
  }

  CHECK(r.available() % frameBytes == 0,
        "링에 남은 바이트가 프레임 배수가 아님: %zu", r.available());
  CHECK(r.dropped() % frameBytes == 0,
        "드롭된 바이트가 프레임 배수가 아님: %llu", (unsigned long long)r.dropped());

  // 남아있는 모든 데이터가 온전한 프레임인지
  std::vector<uint8_t> out(r.available());
  const size_t n = r.read(out.data(), out.size());
  for (size_t i = 0; i + 3 < n; i += 4) {
    CHECK(out[i] == 0xAA && out[i+1] == 0xBB && out[i+2] == 0xCC && out[i+3] == 0xDD,
          "프레임 경계 어긋남 at %zu", i);
  }
  ok("드롭이 일어나도 남은 데이터는 항상 온전한 프레임");
}

// 실제 사용 형태: RT 생산자 1 + writer 소비자 1. 드롭이 없도록 넉넉히 잡고
// 시퀀스가 한 바이트도 어긋나지 않는지 검사한다.
static void testRingThreaded() {
  section("RingBuffer 멀티스레드 무결성");

  RingBuffer r(1 << 16);
  const size_t kBlocks = 20000;
  const size_t kBlockSize = 64;
  std::atomic<bool> producerDone{false};

  std::thread producer([&] {
    std::vector<uint8_t> block(kBlockSize);
    uint64_t counter = 0;
    for (size_t i = 0; i < kBlocks; ++i) {
      for (auto& b : block) b = static_cast<uint8_t>(counter++);
      // 링이 차면 소비자가 비울 때까지 재시도 (드롭 없이 전량 검증하려는 테스트 의도)
      while (!r.write(block.data(), block.size())) std::this_thread::yield();
    }
    producerDone.store(true, std::memory_order_release);
  });

  uint64_t verified = 0;
  std::thread consumer([&] {
    std::vector<uint8_t> out(4096);
    for (;;) {
      const size_t n = r.read(out.data(), out.size());
      if (n == 0) {
        if (producerDone.load(std::memory_order_acquire) && r.available() == 0) break;
        std::this_thread::yield();
        continue;
      }
      for (size_t i = 0; i < n; ++i) {
        if (out[i] != static_cast<uint8_t>(verified)) {
          printf("  FAIL 시퀀스 어긋남 at %llu: got=%u want=%u\n",
                 (unsigned long long)verified, out[i], (unsigned)(verified & 0xFF));
          ++g_fail;
          return;
        }
        ++verified;
      }
    }
  });

  producer.join();
  consumer.join();

  CHECK(verified == kBlocks * kBlockSize,
        "검증된 바이트 %llu != 기대 %zu", (unsigned long long)verified, kBlocks * kBlockSize);
  // dropped()는 0이 아니다 — 이 테스트는 링이 찰 때 재시도하는데, 거절된 write() 호출마다
  // 카운터가 오르기 때문이다. 실제 손실은 없다(위 시퀀스 검증이 전량 일치를 보장한다).
  // 실사용의 RT 스레드는 재시도하지 않으므로 그쪽에서는 카운터 = 실제 유실량이 맞다.
  CHECK(r.available() == 0, "소비 후 링이 비어야 함: %zu", r.available());
  printf("  ok   생산자/소비자 동시 실행 %llu바이트 전량 일치\n", (unsigned long long)verified);
}

// ─────────────────────────────────────────────────────────────────────────
// sample_convert
// ─────────────────────────────────────────────────────────────────────────

static void testSupported() {
  section("supported() / bytesPerSample()");

  CHECK(convert::supported(convert::kInt32LSB), "Int32LSB(실측 포맷)이 미지원");
  CHECK(convert::supported(convert::kInt24LSB), "Int24LSB 미지원");
  CHECK(convert::supported(convert::kFloat32LSB), "Float32LSB 미지원");
  CHECK(!convert::supported(0), "Int16MSB(0)는 거절해야 함");
  CHECK(!convert::supported(2), "Int32MSB(2)는 거절해야 함");
  CHECK(!convert::supported(32), "DSD(32)는 거절해야 함");
  ok("LSB 계열 수락 / MSB·DSD 거절");

  CHECK(convert::bytesPerSample(convert::kInt16LSB) == 2, "Int16 크기");
  CHECK(convert::bytesPerSample(convert::kInt24LSB) == 3, "Int24 크기");
  CHECK(convert::bytesPerSample(convert::kInt32LSB) == 4, "Int32 크기");
  CHECK(convert::bytesPerSample(convert::kFloat64LSB) == 8, "Float64 크기");
  ok("bytesPerSample");
}

static void testToInt16Int32LSB() {
  section("toInt16 — Int32LSB (miniDSP 실측 포맷)");

  // int32 최상위 16비트가 그대로 int16이 된다
  const int32_t src[] = {
      0,
      0x7FFFFFFF,           // +full → 32767
      static_cast<int32_t>(0x80000000),  // -full → -32768
      0x00010000,           // → 1
      static_cast<int32_t>(0xFFFF0000),  // → -1
  };
  const int16_t want[] = {0, 32767, -32768, 1, -1};

  int16_t dst[5] = {0};
  convert::toInt16(convert::kInt32LSB, src, dst, 5, 1);
  for (int i = 0; i < 5; ++i)
    CHECK(dst[i] == want[i], "[%d] got=%d want=%d", i, dst[i], want[i]);
  ok("전 범위 값 5종");
}

static void testToInt16Int24LSB() {
  section("toInt16 — Int24LSB (3바이트 패킹)");

  // 리틀엔디언 3바이트: b0=LSB, b2=MSB. 상위 16비트를 취한다.
  const uint8_t src[] = {
      0x00, 0x00, 0x00,  // 0            → 0
      0xFF, 0xFF, 0x7F,  // +8388607     → 0x7FFF = 32767
      0x00, 0x00, 0x80,  // -8388608     → 0x8000 = -32768
      0x00, 0x00, 0x01,  // 0x010000     → 0x0100 = 256
      0xAA, 0x34, 0x12,  // 0x1234AA     → 0x1234 = 4660
  };
  const int16_t want[] = {0, 32767, -32768, 256, 4660};

  int16_t dst[5] = {0};
  convert::toInt16(convert::kInt24LSB, src, dst, 5, 1);
  for (int i = 0; i < 5; ++i)
    CHECK(dst[i] == want[i], "[%d] got=%d want=%d", i, dst[i], want[i]);
  ok("패킹 해제 + 상위 16비트 추출");
}

static void testToInt16Float() {
  section("toInt16 — Float32LSB (클리핑 포함)");

  const float src[] = {0.0f, 1.0f, -1.0f, 0.5f, 2.0f, -2.0f};
  int16_t dst[6] = {0};
  convert::toInt16(convert::kFloat32LSB, src, dst, 6, 1);

  CHECK(dst[0] == 0, "0.0 → %d", dst[0]);
  CHECK(dst[1] == 32767, "1.0 → %d", dst[1]);
  // 대칭 스케일링(×32767)이라 -32768이 아니라 -32767이 정상 — sample_convert.h 참고
  CHECK(dst[2] == -32767, "-1.0 → %d", dst[2]);
  CHECK(dst[3] > 16000 && dst[3] < 16500, "0.5 → %d (≈16383 기대)", dst[3]);
  CHECK(dst[4] == 32767, "2.0은 +32767로 클리핑되어야 함, got %d", dst[4]);
  CHECK(dst[5] == -32768, "-2.0은 -32768로 클리핑되어야 함, got %d", dst[5]);
  ok("범위 밖 입력이 클리핑됨 (랩어라운드 없음)");
}

static void testToInt16AlignedVariants() {
  section("toInt16 — Int32LSB16/18/20/24");

  // 유효 비트 N의 우측 정렬 값 → (N-16) 시프트
  struct { long type; int32_t in; int16_t want; const char* label; } cases[] = {
      {convert::kInt32LSB16, 12345,        12345,  "LSB16: 시프트 없음"},
      {convert::kInt32LSB18, 12345 << 2,   12345,  "LSB18: >>2"},
      {convert::kInt32LSB20, 12345 << 4,   12345,  "LSB20: >>4"},
      {convert::kInt32LSB24, 12345 << 8,   12345,  "LSB24: >>8"},
      // 음수 좌시프트는 UB라 곱셈으로 쓴다 (-12345 << 8 이 아니라)
      {convert::kInt32LSB24, -12345 * 256, -12345,  "LSB24: 음수 산술 시프트"},
  };

  for (auto& c : cases) {
    int16_t dst = 0;
    convert::toInt16(c.type, &c.in, &dst, 1, 1);
    CHECK(dst == c.want, "%s: got=%d want=%d", c.label, dst, c.want);
  }
  ok("정렬 변형 4종 + 음수 부호 유지");
}

// 가장 실수하기 쉬운 부분 — ASIO는 채널당 분리 버퍼라 인터리브를 우리가 한다.
static void testInterleaveStride() {
  section("toInt16 — 인터리브 stride (ASIO 논인터리브 → 인터리브)");

  const int32_t ch0[] = {0x00010000, 0x00020000, 0x00030000};  // → 1, 2, 3
  const int32_t ch1[] = {0x00FF0000, 0x00FE0000, 0x00FD0000};  // → 255, 254, 253

  int16_t out[6] = {0};
  convert::toInt16(convert::kInt32LSB, ch0, out + 0, 3, 2);  // ch0 → 슬롯 0,2,4
  convert::toInt16(convert::kInt32LSB, ch1, out + 1, 3, 2);  // ch1 → 슬롯 1,3,5

  const int16_t want[] = {1, 255, 2, 254, 3, 253};
  for (int i = 0; i < 6; ++i)
    CHECK(out[i] == want[i], "[%d] got=%d want=%d", i, out[i], want[i]);
  ok("2채널 인터리브 배치 정확");

  // 8채널 장치에서 앞 2채널만 뽑는 실제 시나리오
  int16_t out8[4] = {0};
  convert::toInt16(convert::kInt32LSB, ch0, out8 + 0, 2, 2);
  convert::toInt16(convert::kInt32LSB, ch1, out8 + 1, 2, 2);
  CHECK(out8[0] == 1 && out8[1] == 255 && out8[2] == 2 && out8[3] == 254,
        "8ch 장치에서 앞 2채널 추출: %d %d %d %d", out8[0], out8[1], out8[2], out8[3]);
  ok("다채널 장치에서 ch0/ch1만 추출");
}

static void testUnsupportedIsSilent() {
  section("toInt16 — 미지원 포맷은 무음");

  const int32_t src[] = {0x7FFFFFFF, 0x7FFFFFFF};
  int16_t dst[2] = {123, 456};
  convert::toInt16(/*Int32MSB=*/2, src, dst, 2, 1);
  CHECK(dst[0] == 0 && dst[1] == 0, "미지원 포맷이 잡음을 냄: %d %d", dst[0], dst[1]);
  ok("잡음 대신 0으로 채움");
}

static void testFromFloatRoundTrip() {
  section("fromFloat — 왕복 (play-capture 출력 경로)");

  const float src[] = {0.0f, 0.5f, -0.5f, 1.0f, -1.0f};

  // Int32LSB로 내보냈다가 다시 int16으로 읽어 부호/크기가 보존되는지
  int32_t enc[5] = {0};
  convert::fromFloat(convert::kInt32LSB, src, enc, 5);
  int16_t back[5] = {0};
  convert::toInt16(convert::kInt32LSB, enc, back, 5, 1);

  CHECK(back[0] == 0, "0.0 왕복 → %d", back[0]);
  CHECK(back[1] > 16000 && back[1] < 16500, "0.5 왕복 → %d", back[1]);
  CHECK(back[2] < -16000 && back[2] > -16500, "-0.5 왕복 → %d", back[2]);
  CHECK(back[3] == 32767, "1.0 왕복 → %d", back[3]);
  CHECK(back[4] == -32767 || back[4] == -32768, "-1.0 왕복 → %d", back[4]);
  ok("Int32LSB 왕복 시 부호·크기 보존");

  // 클리핑
  const float loud[] = {5.0f, -5.0f};
  int32_t encLoud[2] = {0};
  convert::fromFloat(convert::kInt32LSB, loud, encLoud, 2);
  CHECK(encLoud[0] == 2147483647, "5.0 → %d (클리핑 기대)", encLoud[0]);
  CHECK(encLoud[1] == -2147483647, "-5.0 → %d (클리핑 기대)", encLoud[1]);
  ok("범위 밖 입력 클리핑 (랩어라운드 없음)");

  // Int24LSB 바이트 패킹
  const float half[] = {1.0f};
  uint8_t enc24[3] = {0};
  convert::fromFloat(convert::kInt24LSB, half, enc24, 1);
  CHECK(enc24[0] == 0xFF && enc24[1] == 0xFF && enc24[2] == 0x7F,
        "1.0 → 24bit max 기대, got %02X %02X %02X", enc24[0], enc24[1], enc24[2]);
  ok("Int24LSB 3바이트 패킹");
}

int main() {
  printf("Phase 1 단위 테스트 — ring_buffer.h / sample_convert.h\n");

  testRingBasic();
  testRingWrap();
  testRingFullDropsWholeBlock();
  testRingFrameIntegrityUnderDrops();
  testRingThreaded();

  testSupported();
  testToInt16Int32LSB();
  testToInt16Int24LSB();
  testToInt16Float();
  testToInt16AlignedVariants();
  testInterleaveStride();
  testUnsupportedIsSilent();
  testFromFloatRoundTrip();

  printf("\n%s\n", g_fail == 0 ? "전체 통과" : "실패 있음");
  if (g_fail) printf("실패 %d건\n", g_fail);
  return g_fail != 0;
}
