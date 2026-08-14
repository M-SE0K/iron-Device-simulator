// index.ts — 파이프라인 4개 노드 성능 계측의 진입점.
//
// NEXT_PUBLIC_IRON_PERF가 빌드 타임에 "1"이 아니면(배포 빌드 기본값) IRON_PERF_ENABLED가
// false로 인라인 치환되고, Next.js가 이를 참조하는 분기를 통째로 dead-code로 제거한다 —
// 계측 코드가 배포 번들에 전혀 들어가지 않는다(scripts/build/build-desktop.sh 참고).
//
// window.__ironPerf로 콘솔에서 실제로 값을 조회하려면 Tauri DevTools(WebView 인스펙터)도
// 열려 있어야 한다 — build-tauri.sh의 --dev가 devtools 피처도 함께 켠다
// (src-tauri/Cargo.toml [features] 주석 참고).
import { syncListen } from "@/shared/lib/tauri-bridge/sync-listen";
import { ironPerfCollector, type PerfSnapshot } from "./collector";

export const IRON_PERF_ENABLED = process.env.NEXT_PUBLIC_IRON_PERF === "1";

export { ironPerfCollector };
export type { PerfSnapshot };

/** ③(WASM 엔진)/④(렌더)가 직접 잰 개별 표본을 기록한다. 꺼져 있으면 no-op. */
export function recordPerfSample(stage: string, ms: number): void {
  if (!IRON_PERF_ENABLED) return;
  ironPerfCollector.record(stage, ms);
}

interface NativeAggregate {
  count: number;
  avgUs: number;
  maxUs: number;
  minUs: number;
}

// Rust(src-tauri/src/perf.rs, streaming.rs)가 emit하는 `iron-perf` 앱 이벤트 페이로드.
// ipc_streaming만 read/send 두 하위 채널로 나뉘고, 나머지(asio_capture/coreaudio_capture)는
// 최상위에 count/avgUs/maxUs/minUs를 바로 싣는다 — 두 네이티브 헬퍼(asio_backend.cpp/
// mac.swift)가 stderr로 흘려보내는 것과 동일한 스키마.
interface NativePerfEvent extends Partial<NativeAggregate> {
  type: "perf";
  stage: string;
  read?: NativeAggregate;
  send?: NativeAggregate;
}

function toSnapshot(agg: NativeAggregate): PerfSnapshot {
  return {
    count: agg.count,
    avgMs: agg.avgUs / 1000,
    minMs: agg.minUs / 1000,
    maxMs: agg.maxUs / 1000,
  };
}

let initialized = false;

/** 앱 부트스트랩(IronPerfInit — TauriBridgeInit과 같은 자리)에서 한 번만 호출한다. */
export function initIronPerf(): () => void {
  if (!IRON_PERF_ENABLED || typeof window === "undefined") return () => {};
  if (initialized) return () => {};
  initialized = true;

  (window as unknown as { __ironPerf: unknown }).__ironPerf = {
    snapshot: () => ironPerfCollector.snapshot(),
    reset: () => ironPerfCollector.reset(),
    subscribe: (fn: (stage: string, ms: number) => void) => ironPerfCollector.subscribe(fn),
  };

  return syncListen<NativePerfEvent>("iron-perf", (payload) => {
    if (payload.stage === "ipc_streaming") {
      if (payload.read) ironPerfCollector.recordAggregate("ipc_streaming_read", toSnapshot(payload.read));
      if (payload.send) ironPerfCollector.recordAggregate("ipc_streaming_send", toSnapshot(payload.send));
      return;
    }
    if (
      payload.count != null &&
      payload.avgUs != null &&
      payload.maxUs != null &&
      payload.minUs != null
    ) {
      ironPerfCollector.recordAggregate(
        payload.stage,
        toSnapshot({ count: payload.count, avgUs: payload.avgUs, maxUs: payload.maxUs, minUs: payload.minUs }),
      );
    }
  });
}
