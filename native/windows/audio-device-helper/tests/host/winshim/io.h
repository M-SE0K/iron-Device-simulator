// io.h — 호스트 테스트 전용 shim. MSVC의 _read/_fileno/_setmode를 POSIX로 잇는다.
#pragma once

#include <cstdio>
#include <unistd.h>

inline int _fileno(FILE* f) { return fileno(f); }
inline int _read(int fd, void* buf, unsigned n) {
  return static_cast<int>(::read(fd, buf, n));
}
// POSIX에는 텍스트/바이너리 구분이 없다 — 호출 자체가 무의미하므로 성공만 돌려준다.
inline int _setmode(int, int) { return 0; }
