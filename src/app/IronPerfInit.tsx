"use client";

// IronPerfInit — 파이프라인 4개 노드 성능 계측 훅(window.__ironPerf)을 모듈 평가 시점에
// 설치하는 부트스트랩. TauriBridgeInit(같은 디렉터리)과 동일한 패턴 — 아무것도 렌더링하지
// 않는다. NEXT_PUBLIC_IRON_PERF가 꺼져 있으면(배포 빌드 기본값) initIronPerf()는 즉시
// no-op으로 반환하고, 이 모듈이 참조하는 계측 코드 경로도 빌드 타임에 dead-code로 제거된다
// (src/shared/lib/iron-perf/index.ts 참고).
import { initIronPerf } from "@/shared/lib/iron-perf";

initIronPerf();

export default function IronPerfInit() {
  return null;
}
