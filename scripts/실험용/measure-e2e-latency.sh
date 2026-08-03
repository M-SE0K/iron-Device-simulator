#!/usr/bin/env bash
# scripts/measure-e2e-latency.sh — E2E 지연 실험(N1~N12) 실행 도우미.
# 자세한 설명은 docs/e2e-latency-experiment.md 참고.
#
# 이 스크립트가 자동화하는 것: dev 서버 기동 + ?e2e=1 URL 오픈.
# 자동화하지 않는 것(=사람이 해야 함): 실제 파일 재생/마이크 녹음, 결과 확인.
# 이 저장소는 자동화된 브라우저 러너를 의도적으로 두지 않는다(과거 Puppeteer 기반 러너는 제거됨).
#
# N1(네이티브 IPC 릴레이, 네이티브 캡처가 있는 Tauri 앱 전용)까지 보려면 이 스크립트 대신:
#   npm run build:tauri:mac && npm run tauri:preview
# 로 앱을 띄우고 WebView 인스펙터 콘솔에서 window.__ironE2E.enable()을 재생/녹음 전에 실행할 것.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}/?e2e=1"

echo "=========================================================="
echo " E2E 지연 실험 (N1~N12) — docs/e2e-latency-experiment.md"
echo "=========================================================="
echo "브라우저(WASM 엔진, N2~N12)만 자동으로 띄웁니다: ${URL}"
echo "네이티브 캡처(N1)까지 보려면 Tauri 앱으로 열어야 합니다:"
echo "  npm run build:tauri:mac && npm run tauri:preview"
echo
echo "다음은 자동화할 수 없습니다(실제 오디오 세션이 필요) — 브라우저가 열리면 직접:"
echo "  1) 개발자 콘솔:  window.__ironE2E.enable()"
echo "  2) 파일을 올려 재생하거나 마이크로 30초~1분 이상 녹음"
echo "  3) 정지 후 콘솔:  window.__ironE2E.report()     (표로 요약)"
echo "                    window.__ironE2E.download()   (JSON 저장, raw 샘플 포함)"
echo "=========================================================="
echo

npm run dev -- -p "$PORT" &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

# dev 서버가 포트를 열 때까지 대기 (최대 30초)
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
else
  echo "브라우저를 직접 열어 ${URL} 로 접속하세요."
fi

wait "$DEV_PID"
