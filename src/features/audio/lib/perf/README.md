# perf

## 1. 도메인 설명

실시간 파이프라인의 지연을 HW capture → Encoding → WASM → Decoding → ECharts render 5단계로 재는 측정 하네스입니다. `perf-e2e/`와 달리 켜고 끄는 게이트가 없어 캡처 세션이 시작되는 순간부터 늘 기록합니다. 결과는 브라우저 콘솔에서 `window.__ironPerf`로 확인합니다.

## 2. 프로젝트 전반에서의 역할

`perf-e2e/`(N1~N12로 더 세분화된 opt-in 실험) 옆에 나란히 놓인 가벼운 상시 계측 경로입니다. 두 하네스가 만나는 접점은 `capture-telemetry.ts` 하나뿐입니다. 캡처 세션을 시작할 때 이 파일이 `perf`와 `e2e` 두 수집기를 함께 켜면서 캡처 파이프라인의 계측 지점(청크 도착, 인코딩, 프레임 전송)까지 헬퍼 하나로 묶습니다. `perf` 자체는 `perf-e2e`를 가져오지 않습니다. 이 방향의 의존은 `capture-telemetry.ts` 안에서만 일어납니다. 반대로 통계 계산(`statistics.ts`)은 `perf-e2e/types.ts`도 그대로 씁니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `statistics.ts` | 배열 하나를 count/avg/min/max/p50/p95/p99 통계로 요약하는 `summarizeStats()`. `perf-e2e`도 그대로 재사용 |
| `types.ts` | `PerfFrameSample`/`PerfRenderSample`/`PerfSessionMeta`/`PerfExport` 타입 |
| `collector.ts` | 싱글턴 수집기 `perf`. 세션/프레임/렌더를 기록하고 `window.__ironPerf`로 전역 노출 |
| `capture-telemetry.ts` | 캡처 훅에서 `perf`와 `e2e` 두 수집기를 함께 시작·계측하는 공용 헬퍼 `createCaptureTelemetry()` |

## 4. 의존성 및 흐름

- **가져오는 것**: `@/shared/lib/utils`의 `downloadJsonArtifact`/`round3`. `capture-telemetry.ts`만 예외로 `../perf-e2e/collector`의 `e2e`까지 가져옵니다.
- **소비하는 도메인**: `player/`의 `useNativeCapture.ts`가 `createCaptureTelemetry()`로 세션을 열고 `markChunkArrival`/`measureEncoding`/`markEncodedFrame`을 호출합니다. 같은 도메인의 `useCaptureSession.ts`는 분석 결과를 받을 때마다 `perf.recordFrame()`을, 세션이 끝나면 `perf.endSession()`을 직접 부릅니다. 차트 쪽에서는 `chart/`의 `useMetricChartRuntime.ts`가 렌더를 커밋할 때 `perf.recordRender()`를 부릅니다.

```
캡처 세션 시작 → createCaptureTelemetry() → perf.startSession() + e2e.startSession() 동시 실행
캡처 청크 도착 → markChunkArrival() → perf.markChunkArrival()(HW capture 간격 기록)
프레임 인코딩 → measureEncoding(fn) → 내부적으로 e2e.time("N2", fn)을 거쳐 실행
프레임 전송 → markEncodedFrame(frame) → perf.markFrameSent(encodingMs)
분석 결과 수신 → useCaptureSession.ts: perf.recordFrame(time, wasmMs, decodingMs)
차트 렌더 커밋 → useMetricChartRuntime.ts: perf.recordRender(metric, ms)
콘솔에서 window.__ironPerf.summary() / .download()
```

## 5. 주요 인터페이스 / 진입점

- **`perf`** (싱글턴, `collector.ts`) — `window.__ironPerf`에 노출되는 것은 `isActive()`/`frameCount()`/`summary()`/`export()`/`download(filename?)`/`reset()`뿐입니다. `startSession`/`endSession`/`markChunkArrival`/`markFrameSent`/`recordFrame`/`recordRender`는 전역에 나오지 않습니다. 계측 지점 코드가 `perf` 모듈을 직접 import해서 부릅니다.
- **`summarizeStats(values: number[]): StatBlock`** — 빈 배열이면 전부 `null`인 블록을 돌려줍니다.
- **`createCaptureTelemetry(options): { markChunkArrival, measureEncoding, markEncodedFrame }`** — `mode`/`sampleRate`/`samplesPerCh`/`channels`/`deviceName`/`onEncodedFrame`을 받습니다. `perf`·`e2e` 세션을 함께 시작한 뒤 캡처 파이프라인의 계측 지점 3개(청크 도착·인코딩·프레임 전송)를 묶어 돌려줍니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. `capture-telemetry.ts`(`perf`/`perf-e2e` 동시 시작 헬퍼)를 이미 뽑아 둔 상태를 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
