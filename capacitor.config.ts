import type { CapacitorConfig } from "@capacitor/cli";

// scripts/build-mobile.sh 가 만드는 정적 산출물(out/)을 그대로 패키징한다.
// 서버/WS 없이 동작 — 분석은 브라우저(WebView) 안의 WASM 엔진이 직접 수행한다
// (src/features/audio/lib/engine/protocol/local-socket.ts).
const config: CapacitorConfig = {
  appId: "com.irondevice.audiosim",
  appName: "Iron Device Audio",
  webDir: "out",
};

export default config;
