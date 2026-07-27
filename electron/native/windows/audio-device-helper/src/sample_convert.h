// sample_convert.h — ASIO 네이티브 샘플 포맷 ↔ 우리 포맷 변환.
//
// CoreAudio는 항상 Float32를 주지만 ASIO는 **드라이버 네이티브 포맷을 그대로** 준다.
// 그래서 macOS 헬퍼엔 없던 변환 계층이 필요하다.
//
// 방향 두 가지:
//   capture      : 장치 네이티브 → int16 인터리브 (stdout 계약)
//   play-capture : float mono [-1,1] → 장치 네이티브 (--ref 재생)
//
// ─────────────────────────────────────────────────────────────────────────
// 이 헤더는 의도적으로 asio.h를 include하지 않는다.
//
// SDK 헤더를 끌어오면 Windows 전용이 되어 WSL에서 단위 테스트를 돌릴 수 없다.
// 대신 ASIO의 타입 번호를 그대로 복제해 두고, asio_backend.cpp에서 static_assert로
// 실제 ASIOSampleType 값과 일치하는지 검증한다 — 값이 어긋나면 컴파일이 깨진다.
// ─────────────────────────────────────────────────────────────────────────
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace convert {

// asio.h의 ASIOSampleType과 같은 번호. LSB 계열만 다룬다 — 아래 supported() 참고.
enum SampleType : long {
  kInt16LSB   = 16,
  kInt24LSB   = 17,  // 3바이트 패킹
  kInt32LSB   = 18,  // ← miniDSP/MCHStreamer 실측값
  kFloat32LSB = 19,
  kFloat64LSB = 20,
  kInt32LSB16 = 24,  // 32비트 컨테이너, 유효 16비트
  kInt32LSB18 = 25,
  kInt32LSB20 = 26,
  kInt32LSB24 = 27,
};

// MSB(빅엔디언) 계열은 지원하지 않는다. 구형 PowerPC Mac 하드웨어용이라 Windows에서는
// 사실상 나타나지 않는다 — 검증할 수 없는 바이트스왑 코드를 넣어 조용히 잡음을 내보내느니
// 명시적으로 거절하고 헤더에 unsupported-sample-type(<n>)을 싣는다.
inline bool supported(long type) {
  switch (type) {
    case kInt16LSB: case kInt24LSB: case kInt32LSB:
    case kFloat32LSB: case kFloat64LSB:
    case kInt32LSB16: case kInt32LSB18: case kInt32LSB20: case kInt32LSB24:
      return true;
    default:
      return false;
  }
}

namespace detail {

// 클리핑 포함 float → int16. NaN은 0으로 떨어진다(비교가 모두 false라 else 분기).
//
// ⚠️ 의도적으로 **대칭 스케일링**(×32767)이다. 따라서 -1.0f는 -32768이 아니라 **-32767**이
// 된다. int16의 음수 범위 한 칸을 못 쓰지만, +1.0과 -1.0이 크기가 같아져 DC 오프셋과
// 비대칭 왜곡이 생기지 않는다. 오디오에서 일반적인 선택이다.
//
// 정수 경로(narrow())는 산술 시프트라 0x80000000 → -32768이 그대로 나온다. 두 경로의
// 최대 음수값이 1LSB 다른 것은 정상이며 버그가 아니다.
inline int16_t clipToInt16(double v) {
  const double s = v * 32767.0;
  if (s >= 32767.0) return 32767;
  if (s <= -32768.0) return -32768;
  return static_cast<int16_t>(s);
}

// 유효 비트 수 N의 32비트 우측 정렬 값 → int16 (N-16 만큼 산술 시프트)
inline int16_t narrow(int32_t v, int significantBits) {
  return static_cast<int16_t>(v >> (significantBits - 16));
}

inline double clip1(double v) {
  if (v >= 1.0) return 1.0;
  if (v <= -1.0) return -1.0;
  return v;  // NaN이면 그대로 통과 → 아래 캐스팅에서 0에 가깝게 처리됨
}

}  // namespace detail

// ── capture 방향 ─────────────────────────────────────────────────────────
//
// ASIO 입력 버퍼는 **채널당 분리(non-interleaved)** 다. CoreAudio와 다른 점이라
// 인터리브는 우리가 한다. 그래서 목적지에 stride를 받는다.
//
//   src      : 이 채널 하나의 네이티브 샘플 배열 (frames개)
//   dst      : 인터리브 목적지에서 **이 채널의 첫 슬롯**
//   dstStride: 인터리브 채널 수 (다음 프레임까지 건너뛸 int16 개수)
//
// 예) 2채널 인터리브의 ch1을 채우려면 dst = base + 1, dstStride = 2.
inline void toInt16(long type, const void* src, int16_t* dst, size_t frames, size_t dstStride) {
  switch (type) {
    case kInt16LSB: {
      const int16_t* s = static_cast<const int16_t*>(src);
      for (size_t i = 0; i < frames; ++i) dst[i * dstStride] = s[i];
      break;
    }
    case kInt24LSB: {
      // 3바이트 리틀엔디언. 상위 16비트만 취하면 되므로 b1|b2<<8 이면 충분하다
      // (b0은 버려지는 하위 8비트).
      const uint8_t* s = static_cast<const uint8_t*>(src);
      for (size_t i = 0; i < frames; ++i) {
        const uint8_t* p = s + i * 3;
        dst[i * dstStride] = static_cast<int16_t>(
            static_cast<uint16_t>(p[1]) | (static_cast<uint16_t>(p[2]) << 8));
      }
      break;
    }
    case kInt32LSB: {
      const int32_t* s = static_cast<const int32_t*>(src);
      for (size_t i = 0; i < frames; ++i) dst[i * dstStride] = detail::narrow(s[i], 32);
      break;
    }
    case kFloat32LSB: {
      const float* s = static_cast<const float*>(src);
      for (size_t i = 0; i < frames; ++i) dst[i * dstStride] = detail::clipToInt16(s[i]);
      break;
    }
    case kFloat64LSB: {
      const double* s = static_cast<const double*>(src);
      for (size_t i = 0; i < frames; ++i) dst[i * dstStride] = detail::clipToInt16(s[i]);
      break;
    }
    case kInt32LSB16: case kInt32LSB18: case kInt32LSB20: case kInt32LSB24: {
      const int bits = (type == kInt32LSB16) ? 16 : (type == kInt32LSB18) ? 18
                     : (type == kInt32LSB20) ? 20 : 24;
      const int32_t* s = static_cast<const int32_t*>(src);
      for (size_t i = 0; i < frames; ++i) dst[i * dstStride] = detail::narrow(s[i], bits);
      break;
    }
    default:
      // supported()로 미리 걸러야 한다. 여기 도달하면 호출 측 버그다 —
      // 잡음을 내보내느니 무음으로 채운다.
      for (size_t i = 0; i < frames; ++i) dst[i * dstStride] = 0;
      break;
  }
}

// ── play-capture 방향 ────────────────────────────────────────────────────
//
// float mono [-1,1] → 장치 네이티브 1채널 버퍼(연속). ASIO 출력 버퍼도 채널당
// 분리라 stride가 필요 없다.
inline void fromFloat(long type, const float* src, void* dst, size_t frames) {
  switch (type) {
    case kInt16LSB: {
      int16_t* d = static_cast<int16_t*>(dst);
      for (size_t i = 0; i < frames; ++i) d[i] = detail::clipToInt16(src[i]);
      break;
    }
    case kInt24LSB: {
      uint8_t* d = static_cast<uint8_t*>(dst);
      for (size_t i = 0; i < frames; ++i) {
        const int32_t v = static_cast<int32_t>(detail::clip1(src[i]) * 8388607.0);
        d[i * 3 + 0] = static_cast<uint8_t>(v & 0xFF);
        d[i * 3 + 1] = static_cast<uint8_t>((v >> 8) & 0xFF);
        d[i * 3 + 2] = static_cast<uint8_t>((v >> 16) & 0xFF);
      }
      break;
    }
    case kInt32LSB: {
      int32_t* d = static_cast<int32_t*>(dst);
      for (size_t i = 0; i < frames; ++i)
        d[i] = static_cast<int32_t>(detail::clip1(src[i]) * 2147483647.0);
      break;
    }
    case kFloat32LSB: {
      float* d = static_cast<float*>(dst);
      for (size_t i = 0; i < frames; ++i) d[i] = static_cast<float>(detail::clip1(src[i]));
      break;
    }
    case kFloat64LSB: {
      double* d = static_cast<double*>(dst);
      for (size_t i = 0; i < frames; ++i) d[i] = detail::clip1(src[i]);
      break;
    }
    case kInt32LSB16: case kInt32LSB18: case kInt32LSB20: case kInt32LSB24: {
      const int bits = (type == kInt32LSB16) ? 16 : (type == kInt32LSB18) ? 18
                     : (type == kInt32LSB20) ? 20 : 24;
      const double scale = static_cast<double>((1 << (bits - 1)) - 1);
      int32_t* d = static_cast<int32_t*>(dst);
      for (size_t i = 0; i < frames; ++i)
        d[i] = static_cast<int32_t>(detail::clip1(src[i]) * scale);
      break;
    }
    default:
      break;  // 알 수 없는 포맷에 쓰느니 아무것도 하지 않는다 (호출 측이 클리어함)
  }
}

// 이 포맷의 샘플 하나가 차지하는 바이트 수. ASIO 버퍼 포인터 산술에 쓴다.
inline size_t bytesPerSample(long type) {
  switch (type) {
    case kInt16LSB:   return 2;
    case kInt24LSB:   return 3;
    case kFloat64LSB: return 8;
    case kInt32LSB: case kFloat32LSB:
    case kInt32LSB16: case kInt32LSB18: case kInt32LSB20: case kInt32LSB24:
      return 4;
    default: return 0;
  }
}

}  // namespace convert
