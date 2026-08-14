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

export type { PerfSnapshot };

/**
 * ⚠️ 켜짐 판정은 **`process.env.NEXT_PUBLIC_IRON_PERF`를 가드 자리에서 직접** 비교한다.
 * `const ENABLED = …`로 한 번 받아 쓰면 번들러가 그 바인딩이 "항상 false"임을 증명하지 못해
 * 가드가 접히지 않는다. 그리고 그것만으로도 부족하다 — 변수가 **정의되어 있어야** Next가
 * 리터럴로 치환해 주고, 정의돼 있지 않으면 `process.env.X` 런타임 조회로 남긴다. 그래서
 * 기본값 "0"을 next.config.ts의 `env`에 못 박아 둔다. 둘 중 하나라도 빠지면 꺼진 배포
 * 빌드에 계측 코드가 통째로 실린다 — 실측으로 확인한 사항이다.
 */

/** ③(WASM 엔진)/④(렌더)가 직접 잰 개별 표본을 기록한다. 꺼져 있으면 no-op. */
export function recordPerfSample(stage: string, ms: number): void {
  if (process.env.NEXT_PUBLIC_IRON_PERF !== "1") return;
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
  if (process.env.NEXT_PUBLIC_IRON_PERF !== "1" || typeof window === "undefined") return () => {};
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
