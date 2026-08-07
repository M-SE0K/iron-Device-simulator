#!/usr/bin/env bash
# run-stream-test.sh — Windows·ASIO SDK·하드웨어 없이 헬퍼를 검증한다.
#
#   ./tests/host/run-stream-test.sh
#
# 1) asio_backend.cpp 타입체크 — SDK 스텁으로 컴파일만 해본다(실행 없음).
# 2) main.cpp를 가짜 백엔드와 링크해 **실제로 실행**하고 --stream 프로토콜을 검증한다.
#    (ASan+UBSan 한 번, TSan 한 번 — 잡는 버그의 종류가 다르다)
#
# 무엇이 검증되지 않는지는 tests/host/README.md를 볼 것.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

echo "[1/3] asio_backend.cpp 타입체크 (ASIO SDK 스텁)"
# sample_convert.h의 ASIOSampleType 복제본과 스텁을 대조하는 static_assert가 함께 돈다 —
# 스텁 숫자가 SDK와 어긋나면 여기서 걸린다.
g++ -std=c++17 -Wall -Wextra -fsyntax-only \
    -Itests/host/winshim -Itests/host/asiostub -Isrc \
    src/asio_backend.cpp
echo "  ok"

# shim이 -isystem이 아니라 -I인 이유는 fcntl.h의 #include_next 때문이다.
build() {
  g++ -std=c++17 -Wall -Wextra -O1 -g -pthread \
      -Itests/host/winshim -Isrc \
      "$@" src/main.cpp tests/host/fake_backend.cpp
}

echo "[2/3] 시나리오 — ASan + UBSan"
# stdin 리더가 재생 링 안에 머무는 동안 stopCapture가 링을 delete하면 use-after-free다.
# BackendGuard/quiesceBackendCallers가 그걸 막는데, 실기에서는 "가끔 종료할 때 죽는다"는
# 형태로만 드러나 추적이 매우 비싸다 — 여기서 잡는 게 훨씬 싸다.
build -fsanitize=address,undefined -fno-omit-frame-pointer -o "$OUT/helper_san"
# 종료 경로에서 일부러 정리하지 않고 나가는 자리가 있어(프로세스 teardown에 맡김) 누수 검사는 끈다.
ASAN_OPTIONS=detect_leaks=0 python3 tests/host/stream_test.py "$OUT/helper_san"

echo
echo "[3/3] 시나리오 — ThreadSanitizer"
# 락프리 재생 링(SPSC)과 Dekker 종료 핸드셰이크의 메모리 오더링을 본다. ASan과 동시 사용 불가.
build -fsanitize=thread -fno-omit-frame-pointer -o "$OUT/helper_tsan"
python3 tests/host/stream_test.py "$OUT/helper_tsan"
