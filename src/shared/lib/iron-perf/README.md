# iron-perf

## 1. 도메인 설명

실시간 파이프라인(캡처 → 엔진 → 렌더)의 각 스테이지가 실제로 얼마나 걸리는지를 계측 빌드에서 수집해 콘솔 한 줄(`__ironPerf.snapshot()`)로 확인할 수 있게 하는 perf 계측 수집기입니다. 최적화 작업의 전/후 비교가 이 도메인의 존재 이유입니다 — 같은 빌드 안에서 엔벌로프 집계 경로를 WASM/JS/레거시로 바꿔가며 재는 A/B 토글까지 들어 있습니다.

## 2. 프로젝트 전반에서의 역할

계측 빌드(`NEXT_PUBLIC_IRON_PERF=1`)에서만 살아나는 횡단(cross-cutting) 계층입니다. `npm run build:tauri -- --dev`가 이 환경변수를 export하고 WebView 인스펙터(devtools 피처)를 함께 켜므로, 계측이 의미 있는 실행 환경은 Tauri 개발 빌드뿐입니다(`npm run dev:perf`도 같은 env를 켜지만 브라우저에는 네이티브 브리지가 없어 캡처/재생 파이프라인은 측정할 수 없습니다). 배포 빌드에서는 `recordPerfSample()`이 첫 줄에서 반환해 계측 코드가 사실상 비활성입니다. 계측점은 캡처 훅·엔진 클라이언트·대시보드·차트 래퍼 등 앱 전역에 흩어져 있습니다. 이 도메인은 그 값들을 스테이지 이름별 링버퍼로 모으는 수집기 역할만 합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `collector.ts` | `ironPerfCollector` 싱글턴 — 스테이지별 4096샘플 링버퍼(`Float64Array`, 100Hz 스테이지 기준 약 40초 창)와 `record`/`snapshot`/`reset`/`subscribe` |
| `index.ts` | 공개 API — `recordPerfSample`(env 게이트 + User Timing 방출 + collector 기록), `initIronPerf`(`window.__ironPerf` 설치), envelope A/B 토글(`getEnvelopeMode`/`setEnvelopeMode`/`envelopeModeSuffix`), `isIronPerfEnabled` |

## 4. 의존성 및 흐름

이 도메인은 아무 도메인도 import하지 않습니다(표준 `performance` API만 사용). 소비 방향은 전부 바깥 → 안입니다.

```
계측점(호출부)                                    스테이지 이름
  shared/components/UPlotChart.tsx             → chart_render (ms)
  dashboard/DashboardClient.tsx                → render_drain (ms)
  player/capture/useNativeCapture.ts           → reframe, ipc_chunk_gap (ms)
                                               → stream_write_backlog, stream_lead, stream_ring_est (게이지: 프레임 수)
  player/capture/useCaptureSession.ts          → wasm_engine (ms — 엔진이 보고한 processingMs)
  engine/protocol/engine-client.ts             → worker_roundtrip (ms)
  channel/hooks/useProtectedCompareStreams.ts  → envelope_seed[_js|_legacy] (ms)
  channel/hooks/useChannelWaveStreams.ts       → envelope_backfill[_js|_legacy] (ms)

recordPerfSample(stage, ms)
  → env 게이트(NEXT_PUBLIC_IRON_PERF !== "1"이면 no-op)
  → performance.measure("iron:<stage>", [now-ms, now]) — DevTools Performance 패널 Timings 레인용 소급 기록
  → ironPerfCollector.record() → 스테이지 링버퍼 push + subscribe 리스너 통지

DevTools 콘솔 ← __ironPerf.snapshot() → { <stage>: {count, totalCount, avgMs, minMs, maxMs, p95Ms} }
```

envelope A/B 토글은 반대 방향으로도 걸쳐 있습니다. `lib/pcm-kit.ts`(WASM 커널 우회 여부)와 `lib/render/wave-store.ts`(레거시 per-sample 경로)가 `getEnvelopeMode()`를 읽어 집계 경로를 갈아탑니다. 채널 훅 두 곳은 `envelopeModeSuffix()`로 스테이지 이름에 `_js`/`_legacy` 접미사를 붙여 한 스냅숏 안에서 모드별 수치가 나란히 보이게 합니다. 모드는 localStorage 키 `iron-perf.envelope-mode`에 영속되므로, 전환 후 파일 재업로드/뷰 토글로 시나리오를 다시 트리거하면 됩니다.

## 5. 주요 인터페이스 / 진입점

- **`recordPerfSample(stage: string, ms: number): void`** — 계측점이 부르는 단일 기록 함수. 계측 빌드가 아니면 no-op. `ms` 자리에 프레임 수 같은 게이지 값을 넣어도 됩니다(통계 구조 재사용 — 필드 이름만 `*_ms`).
- **`isIronPerfEnabled(): boolean`** — `NEXT_PUBLIC_IRON_PERF === "1"` 여부. `recordPerfSample`은 스스로 가드하므로, 스탬프 배열 유지 같은 계측 "준비" 비용까지 피하려는 호출부만 이 값으로 감쌉니다.
- **`initIronPerf(): void`** — `window.__ironPerf`(`snapshot`/`reset`/`subscribe`/`envelopeMode`) 설치. `src/app/IronPerfInit.tsx`가 모듈 평가 시점에 1회 호출합니다. 계측 빌드가 아니거나 이미 설치됐으면 아무것도 하지 않습니다.
- **`getEnvelopeMode(): "wasm" | "js" | "legacy"`** / **`setEnvelopeMode(mode)`** — 엔벌로프 집계 경로 A/B 토글. 계측 빌드가 아니면 항상 `"wasm"`. 콘솔에서는 `__ironPerf.envelopeMode("legacy")` 형태로 씁니다.
- **`envelopeModeSuffix(): "" | "_js" | "_legacy"`** — envelope 계열 스테이지 이름에 붙일 현재 모드 접미사.
- **`ironPerfCollector`**(`collector.ts`) — `record(stage, ms)` / `snapshot(): Record<string, PerfSnapshot>` / `reset()` / `subscribe(listener): () => void`. 직접 import하는 곳은 `index.ts`뿐이고 외부는 `__ironPerf` 전역으로만 접근합니다.

## 6. 변경 이력(요약)

- 2026-08-19: 최초 작성 (mse0k-domain-tw)
