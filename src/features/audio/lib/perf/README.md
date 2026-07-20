# perf

## 1. 도메인 설명

분석 프레임 하나가 마이크/파일 캡처부터 화면 렌더까지 지나는 다섯 구간(HW capture·Encoding·WASM·Decoding·ECharts render)이 각각 몇 ms 걸리는지 재는 5단계 지연 측정 하네스다. 개발자는 세션 재생 후 브라우저 콘솔에서 `window.__ironPerf.summary()`를 호출하는 것만으로 구간별 평균/p50/p95/p99를 확인할 수 있다.

싱글턴 수집기(`perf`) 하나가 전부를 담당한다. 계측 지점이 캡처 훅(`useNativeCapture`/`useWebAudioWorkletCapture`)·세션 훅(`useCaptureSession`)·차트 컴포넌트(`TemperatureChart`/`ExcursionChart`) 네 곳에 흩어져 있는데, prop/ref로 값을 끌고 다니는 대신 각 지점이 이 모듈을 직접 `import { perf }`해서 호출한다. 세션 생명주기(시작/종료)는 캡처 경로가 소유하고, 측정 결과는 세션이 끝나도 다음 세션이 시작되기 전까지 그대로 보존된다. 자동화 러너(Puppeteer 기반)는 제거됐고, 지금은 수동 호출만 지원한다.

## 2. 프로젝트 전반에서의 역할

이 도메인은 렌더 파이프라인 자체를 구성하지 않는다 — 파이프라인 각 지점에 계측 훅만 꽂아 관찰하는 계측 계층이다.

- `useCaptureSession`이 캡처 시작 시 `perf.startSession(meta)`를, cleanup(세션 종료) 시 `perf.endSession()`을 호출해 수집 구간의 시작과 끝을 정한다. `PerfSessionMeta`(모드·SampleRate·samplesPerCh·채널 수·장치명)가 그 시점에 함께 기록된다.
- 1단계(HW capture)와 2단계(Encoding)는 `useNativeCapture`/`useWebAudioWorkletCapture`가 캡처 콜백 안에서 기록하고, 3·4단계(WASM·Decoding)는 `useCaptureSession`의 `onmessage` "frame" 핸들러가 기록한다. 1·2단계 값은 청크 하나가 와이어 프레임 여러 개로 쪼개질 수 있어 내부 FIFO 큐로 프레임 순서에 맞춰 페어링된다.
- 5단계(ECharts render)는 `TemperatureChart`/`ExcursionChart`가 `perfTrack` prop이 true일 때만 기록한다. `DashboardClient`가 메인 차트 두 개에는 `perfTrack`을 켜고, `ChartDetailOverlay`가 재사용하는 같은 컴포넌트 인스턴스에는 켜지 않아(prop 미전달, 기본값 false) 렌더 계측이 중복 집계되지 않는다.
- 결과는 UI로 노출되지 않는다 — `window.__ironPerf`(`summary`/`export`/`download`)를 브라우저 콘솔에서 직접 호출해 확인하거나 JSON으로 내려받는다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `collector.ts` | 싱글턴 `PerfCollector` 클래스와 인스턴스 `perf`를 export한다. 세션 시작/종료(`startSession`/`endSession`/`isActive`), 단계별 기록(`markChunkArrival`/`markFrameSent`/`recordFrame`/`recordRender`), 통계 산출(`frameCount`/`summary`/`export`/`download`/`reset`)을 제공한다. `stageStats()`가 각 구간 배열에서 count/avg/min/max/p50/p95/p99(소수 3자리 반올림, `round3`)를 계산하는 내부 헬퍼다. 마운트 시 `window.__ironPerf`에 자기 자신을 노출한다. |
| `types.ts` | 측정 스키마 정의. `PerfFrameSample`(프레임 1개의 1~4단계 구간, `hwCaptureMs`/`encodingMs`는 첫 청크·청크 내 2번째 이후 프레임에서 `null`), `PerfRenderSample`(렌더 틱 1개의 5단계, 프레임이 아니라 커밋→rendered 이벤트 단위), `PerfStageStats`(구간별 요약 통계), `PerfSessionMeta`(세션 파라미터), `PerfExport`(`window.__ironPerf.export()`가 반환하는 최상위 JSON 스키마)를 export한다. |

## 4. 의존성 및 흐름

**이 도메인이 import하는 것** — 없다. `collector.ts`는 `types.ts`(같은 도메인)만 참조하고, 표준 브라우저 API(`performance.now()`, `Blob`, `URL.createObjectURL`, `document`)만 쓴다.

**이 도메인을 import하는 곳** (계측 지점, 전부 `@/features/audio/lib/perf`의 `perf`를 직접 import):

- `components/player/capture/useNativeCapture.ts` — 캡처 시작 시 `perf.startSession(meta)`, 네이티브 IOProc 청크 도착마다 `perf.markChunkArrival()`(1단계), 와이어 프레임 send 직전 `perf.markFrameSent(encodingMs)`(2단계).
- `components/player/capture/useWebAudioWorkletCapture.ts` — 동일한 역할을 getUserMedia+AudioWorklet 경로에서 수행(`perf.startSession`/`markChunkArrival`/`markFrameSent`).
- `components/player/capture/useCaptureSession.ts` — cleanup 시 `perf.endSession()`. 분석 소켓의 `onmessage` "frame" 처리에서 `perf.recordFrame(frame.time, processingMs, decodingMs)`(3·4단계, 1·2단계 값은 FIFO에서 회수).
- `components/chart/TemperatureChart.tsx` / `components/chart/ExcursionChart.tsx` — `perfTrack` prop이 true일 때만, 프레임 커밋 후 ECharts `rendered` 이벤트 시점에 `perf.recordRender(chart, renderMs)`(5단계).
- `components/dashboard/DashboardClient.tsx` — 메인 온도/익스커션 차트 두 인스턴스에 `perfTrack`을 켠다(`ChartDetailOverlay`가 재사용하는 인스턴스에는 켜지 않아 중복 집계를 막는다).

**내부 처리 흐름** (세션 하나 기준):

```
캡처 시작 → perf.startSession(meta)
  캡처 콜백마다: markChunkArrival()                      # 1. HW capture 간격 기록
  와이어 프레임 send 직전: markFrameSent(encodingMs)       # 2. Encoding, FIFO에 페어링
  ↓ (엔진 왕복)
frame 메시지 수신: recordFrame(audioTime, wasmMs, decodingMs)
  → FIFO에서 1·2단계 값 회수 + 3·4단계 결합해 PerfFrameSample 1건 적재
차트 렌더 커밋 → rendered 이벤트: recordRender(chart, renderMs)   # 5. 렌더 틱 단위
세션 종료 → perf.endSession()                             # 수집만 멈춤, 데이터는 보존
콘솔: window.__ironPerf.summary() / .export() / .download()
```

## 5. 주요 인터페이스 / 진입점

- `perf: PerfCollector`(`collector.ts`) — 싱글턴 인스턴스. 아래 메서드를 계측 지점이 직접 호출한다.
  - `startSession(meta: PerfSessionMeta): void` — 이전 세션 데이터를 버리고 수집을 켠다.
  - `endSession(): void` — 수집을 멈춘다. 데이터는 다음 `startSession`까지 유지된다.
  - `isActive(): boolean` / `frameCount(): number`
  - `markChunkArrival(): void` — 1단계. 캡처 콜백 진입 시 호출, 직전 호출과의 간격을 잰다.
  - `markFrameSent(encodingMs: number | null): void` — 2단계. 와이어 프레임 send 직전 호출.
  - `recordFrame(audioTime: number, wasmMs: number, decodingMs: number): void` — 3·4단계. frame 메시지 처리 완료 시 호출.
  - `recordRender(chart: "temperature" | "excursion", renderMs: number): void` — 5단계. 렌더 틱마다 호출.
  - `summary(): PerfExport["summary"]` — 구간별 요약 통계.
  - `export(): PerfExport | null` — 세션 전체 스냅샷. 세션이 한 번도 시작되지 않았으면 `null`.
  - `download(filename?: string): void` — `export()`를 JSON 파일로 다운로드.
  - `reset(): void` — 수집기를 초기 상태로 되돌린다.
- `window.__ironPerf` — 브라우저 콘솔 전용 진입점. `perf`의 `isActive`/`frameCount`/`summary`/`export`/`download`/`reset` 6개만 노출한다(내부 mark류 메서드는 콘솔에 노출하지 않는다).
- `PerfSessionMeta`(`types.ts`) — `{ mode: "native" | "web"; sampleRate: number; samplesPerCh: number; channels: number; deviceName: string | null }`. `startSession`이 받는 세션 파라미터.
- `PerfExport`(`types.ts`) — `{ meta, summary, frames: PerfFrameSample[], renders: PerfRenderSample[] }`. `meta`는 `PerfSessionMeta` + `startedAt`(ISO 8601)/`durationSec`(초)/`frameCount`.
- `PerfFrameSample`(`types.ts`) — 프레임 1개의 1~4단계 구간(ms). `hwCaptureMs`/`encodingMs`는 값이 없을 수 있어 `number | null`, `wasmMs`/`decodingMs`는 항상 값이 있다.
- `PerfStageStats`(`types.ts`) — `{ count, avg, min, max, p50, p95, p99 }`. 표본이 없으면 `count: 0`이고 나머지는 `null`.

주의사항: 다섯 구간은 서로 겹치지 않는 순수 구간 시간이라 합산이 곧 end-to-end 지연은 아니다. 렌더(5단계)는 프레임 단위가 아니라 코얼레싱 후 커밋되는 렌더 틱 단위로 집계된다.

## 6. 변경 이력(요약)
- 2026-07-20: 최초 작성 (기준 커밋: fb8e4fa)
