import type { NextConfig } from "next";

// 정적 빌드(scripts/build/build-desktop.sh 공용 코어): 순수 정적 산출물을 out/ 에 만든다.
// 분석 엔진은 서버가 아니라 브라우저(WebView) 안의 WASM으로 동작한다
// (engine/protocol/local-socket.ts). 데스크톱 독립 웹앱(npm run build:desktop)과 Tauri
// 패키징(build-tauri.sh)이 이 플래그를 공유한다 — 변수명은 Capacitor 모바일 빌드가
// 있던 시절의 이름을 그대로 유지 중.
const MOBILE_BUILD = process.env.MOBILE_BUILD === "1";

const nextConfig: NextConfig = {
  ...(MOBILE_BUILD ? { output: "export" as const, images: { unoptimized: true } } : {}),
  env: {
    /**
     * 파이프라인 성능 계측(src/shared/lib/iron-perf) 스위치. **기본값을 여기서 못 박는 것이
     * 핵심이다** — Next는 정의되지 않은 NEXT_PUBLIC_* 은 인라인하지 않고 `process.env.X`
     * 런타임 조회로 남기기 때문에, 설정을 비워두면 `if (…!== "1") return` 가드가 빌드 타임에
     * 접히지 못해 **꺼진 배포 빌드에도 계측 코드가 통째로 실린다**(실측 확인). "0"으로
     * 정의해 두면 그 자리에서 리터럴로 치환돼 이후 본문이 도달 불가가 되고 제거된다.
     *
     * 켤 때는 `npm run dev:perf`처럼 이 변수를 1로 넘겨 빌드/실행한다.
     */
    NEXT_PUBLIC_IRON_PERF: process.env.NEXT_PUBLIC_IRON_PERF ?? "0",
  },
};

export default nextConfig;
