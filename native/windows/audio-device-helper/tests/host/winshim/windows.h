// windows.h — 호스트 테스트 전용 얇은 shim (tests/host/README.md 참고).
// main.cpp가 실제로 쓰는 것만 담는다: Sleep / GetTickCount64 / COM 초기화 / HRESULT.
#pragma once

#include <cstdint>
#include <ctime>

typedef long HRESULT;
typedef unsigned long long ULONGLONG;
typedef unsigned long DWORD;

#define FAILED(hr) ((HRESULT)(hr) < 0)

inline HRESULT CoInitialize(void*) { return 0; }
inline void CoUninitialize() {}

inline void Sleep(unsigned long ms) {
  struct timespec ts;
  ts.tv_sec = static_cast<time_t>(ms / 1000);
  ts.tv_nsec = static_cast<long>((ms % 1000) * 1000000UL);
  nanosleep(&ts, nullptr);
}

inline ULONGLONG GetTickCount64() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<ULONGLONG>(ts.tv_sec) * 1000ULL +
         static_cast<ULONGLONG>(ts.tv_nsec) / 1000000ULL;
}

// ── asio_backend.cpp가 쓰는 나머지 Win32 표면 ──────────────────────────────
#include <cstring>
#include <cstdio>
#include <strings.h>

typedef void* HWND;
typedef wchar_t WCHAR;
#define CP_UTF8 65001

struct CLSID {
  unsigned long Data1;
  unsigned short Data2;
  unsigned short Data3;
  unsigned char Data4[8];
};

inline HWND GetDesktopWindow() { return nullptr; }
inline int _stricmp(const char* a, const char* b) { return strcasecmp(a, b); }

inline int StringFromGUID2(const CLSID& id, WCHAR* out, int max) {
  char tmp[64];
  snprintf(tmp, sizeof(tmp), "{%08lX-%04X-%04X}", id.Data1, id.Data2, id.Data3);
  int i = 0;
  for (; tmp[i] && i < max - 1; ++i) out[i] = static_cast<WCHAR>(tmp[i]);
  out[i] = 0;
  return i + 1;
}

inline int WideCharToMultiByte(unsigned, unsigned long, const WCHAR* in, int,
                               char* out, int outBytes, const char*, void*) {
  int i = 0;
  for (; in[i] && i < outBytes - 1; ++i) out[i] = static_cast<char>(in[i]);
  out[i] = 0;
  return i + 1;
}
