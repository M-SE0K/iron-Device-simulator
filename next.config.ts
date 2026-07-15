import type { NextConfig } from "next";

// 정적 빌드(scripts/build-static-local.sh 공용 코어): 순수 정적 산출물을 out/ 에 만든다.
// 분석 엔진은 서버가 아니라 브라우저(WebView) 안의 WASM으로 동작한다
// (engine/protocol/local-socket.ts). 데스크톱 독립 웹앱(build-desktop.sh)과 Electron
// 패키징(build-electron.sh)이 이 플래그를 공유한다 — 변수명은 Capacitor 모바일 빌드가
// 있던 시절의 이름을 그대로 유지 중.
const MOBILE_BUILD = process.env.MOBILE_BUILD === "1";

const nextConfig: NextConfig = {
  ...(MOBILE_BUILD ? { output: "export" as const, images: { unoptimized: true } } : {}),
};

export default nextConfig;
