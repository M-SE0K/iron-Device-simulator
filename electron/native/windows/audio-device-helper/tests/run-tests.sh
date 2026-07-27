#!/usr/bin/env bash
# 단위 테스트. src/ring_buffer.h / src/sample_convert.h는 Windows·ASIO 의존이 없어
# WSL/Linux/macOS에서 그대로 돈다 — 하드웨어도 SDK도 필요 없다.
#
#   ./tests/run-tests.sh
#
# 기본은 UBSan/ASan을 켠다. 링버퍼의 인덱스 산술과 포맷 변환의 시프트/캐스팅은
# 정의되지 않은 동작을 내기 쉬운데, 그런 버그는 실기에서 "가끔 잡음이 섞인다"는
# 형태로만 드러나 추적이 매우 어렵다. 여기서 잡는 게 훨씬 싸다.
set -euo pipefail

cd "$(dirname "$0")"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

echo "[1/2] sanitizer 빌드 (UBSan + ASan)"
g++ -std=c++17 -Wall -Wextra -O1 -g \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    -pthread ring_and_convert_test.cpp -o "$OUT/test_san"
"$OUT/test_san"

echo
echo "[2/2] 최적화 빌드 (-O2, ThreadSanitizer)"
# 락프리 코드의 메모리 오더링 버그는 -O2에서만 드러나는 경우가 많다. TSan으로
# 생산자/소비자 경합도 함께 본다 (ASan과 동시 사용 불가라 별도 빌드).
g++ -std=c++17 -Wall -Wextra -O2 -g \
    -fsanitize=thread -fno-omit-frame-pointer \
    -pthread ring_and_convert_test.cpp -o "$OUT/test_tsan"
"$OUT/test_tsan"

echo
echo "단위 테스트 검증 완료"
