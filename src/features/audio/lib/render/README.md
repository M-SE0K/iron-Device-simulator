# render

## 1. 도메인 설명

실시간 차트·파형을 그리는 데 필요한 순수 계산, 그리고 화면 표시 전용 상태를 React 밖에서 들고 있는 스토어를 모아둔 도메인입니다. 세션이 아무리 길어져도 표시 비용이 늘지 않게 두 겹의 전략을 씁니다 — 적재 쪽은 상한(점 30000개 / 버킷 50000개)에 닿으면 2:1로 압축하고(`ChartStore`, `ChannelWaveStore`), 읽기 쪽은 화면에 보이는 x구간만 픽셀 폭 예산만큼 min/max 컬럼으로 뽑아 커밋합니다(`readRange()`). uPlot 차트가 공통으로 쓰는 축·줌·툴팁·임계선·주석(두 점 잇기) 플러그인도 여기서 제공합니다.

## 2. 프로젝트 전반에서의 역할

`dashboard/`·`chart/`·`channel/`·`calibration/` 네 도메인이 공통으로 기대는 렌더링 인프라입니다. 이 도메인은 화면에 무엇을 얼마나 그릴지만 책임집니다 — 스토어는 상한에서 압축하는 표시용 사본이므로 원본 프레임 보존의 책임은 지지 않고 저장이나 CSV/JSON 내보내기에도 관여하지 않습니다. 파형 엔벨로프의 벌크 집계는 `lib/pcm-kit`의 WASM 커널(미로드 시 JS 폴백)에 맡기고 이 도메인은 버킷 병합과 압축만 담당합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `store-base.ts` | 스토어 공통 베이스 — 구독+버전 관리 `SubscribableStore`, 그 위에 dirty/flush와 스냅샷 캐시를 얹은 `VersionedSnapshotStore` |
| `read-buffer.ts` | `readRange()` 결과를 담아 재사용하는 `SeriesReadBuffer`(기본 8192포인트)와 `createReadBuffer()`, 초기 시드 폭 `SEED_PX_WIDTH`(1024px) |
| `coalesce.ts` | 큐에 쌓인 프레임 여러 개를 하나로 합치는 `coalesceFrames()` |
| `detect-events.ts` | 온도 WARN/DANGER 임계 통과·변위 피크를 감지하는 `detectEvents()`, 기본 임계값 상수 |
| `chart-window.ts` | 온도/변위 차트의 y축 표시 범위 계산 + 파형용 대칭 범위 `symmetricYRange()` |
| `chart-store.ts` | 메인 Temperature/Excursion 차트의 표시 데이터 스토어 `ChartStore` — 점 30000개 상한으로 압축하며, 뷰포트 구간을 min/max 컬럼으로 읽는 `readRange()` 제공 |
| `wave-store.ts` | 채널 파형 하나의 min/max 엔벨로프 스토어 `ChannelWaveStore` — 버킷 50000개 상한, pcm-kit 커널로 인터리브 원본을 채널 추출 없이 벌크 집계 |
| `raw-window.ts` | 깊이 확대한 구간의 원시 샘플을 캡처 스냅샷(`CaptureSnapshot`)에서 직접 읽어오는 `readRawWindow()` |
| `annotation-store.ts` | 차트 위 "두 점 잇기" 주석의 세그먼트·드래프트 상태 `AnnotationStore` |
| `channel-meta.ts` | 채널 번호 → 표시 이름·역할(V/I/Extended)·색상 매핑 |
| `metric-chart-options.ts` | Temperature/ExcursionChart가 공유하는 uPlot 시리즈/옵션 빌더 |
| `uplot-option.ts` | 시간/값 축 빌더, 현재 줌 스팬 기준 소수점 자리수 계산, 영역 채우기 그라디언트(캐시) |
| `uplot-plugins/` | uPlot 플러그인 5종 — `zoom`(휠 줌+더블클릭 리셋), `tooltip`, `thresholds`, `annotate`(두 점 잇기), `envelope-overlay`(`ChannelWaveStore` 직접 스트로크). `index.ts`가 전부 재수출 |

## 4. 의존성 및 흐름

- **가져오는 것**: `features/audio/types`의 `AnalysisFrame`, `lib/pcm-kit`의 `aggregateEnvelope`/`PcmSource`, `lib/engine/core`의 `INT16_SCALE`, `components/player/capture/types`의 `CaptureSnapshot`(`raw-window.ts`가 역방향으로 컴포넌트 계층의 타입을 참조), `@/shared/lib`의 `dpr-cap`/`element-rect`/`frame-scheduler`, `@/shared/lib/iron-perf`의 `getEnvelopeMode`(엔벨로프 A/B 측정 토글), `@/shared/components/UPlotChart`의 `UPlotOptions` 타입, `uplot` 라이브러리 자체.
- **소비하는 도메인**:
  - `dashboard/` — `DashboardClient.tsx`가 `coalesceFrames`/`detectEvents`로 출력 큐를 배치 처리한 결과를 `ChartStore.push()`에 넣고 뷰(카드)별 `AnnotationStore`를 생성해 내려줍니다. `ChannelChartCard.tsx`는 `channel-meta`/`wave-store`/`annotation-store`를, `hooks/useFrameCachePersistence.ts`는 `ChartStore`를, `hooks/useWorkspaceSave.ts`는 `detect-events`의 `TempThresholds` 타입을 씁니다.
  - `chart/` — `TemperatureChart`/`ExcursionChart`와 그 훅들이 `chart-store`/`chart-window`/`annotation-store`/`read-buffer`/`metric-chart-options`/`uplot-plugins`/`detect-events` 상수를 가져다 씁니다.
  - `channel/` — `ChannelWaveformCanvas`가 `wave-store`/`raw-window`/`read-buffer`/`chart-window`/`uplot-option`/`uplot-plugins`(zoom·tooltip·annotate)를, `ProtectedComparePanel`이 `envelope-overlay`/`symmetricYRange`를, `hooks/useChannelWaveStreams`·`hooks/useProtectedCompareStreams`가 `ChannelWaveStore`를 씁니다.
  - `calibration/` — `calibration-options.ts`가 `detect-events`의 기본 온도 임계값 상수를 재사용합니다.

```
엔진 프레임 → coalesceFrames/detectEvents(배치 처리) → ChartStore.push() → flush()
    → 구독 차트가 view(x구간, 픽셀 폭)로 readRange() → SeriesReadBuffer → uPlot 커밋

캡처 청크(인터리브 int16/float32) → ChannelWaveStore.addSamples()
    → pcm-kit aggregateEnvelope(WASM 커널, 미로드 시 JS 폴백) → 버킷 병합
    → ChannelWaveformCanvas 소스 readRange() 또는 envelope-overlay 플러그인이 캔버스에 직접 스트로크

깊은 확대(버킷 폭보다 좁은 구간) → readRawWindow(CaptureSnapshot) → 원시 샘플을 같은 버퍼로 커밋
```

## 5. 주요 인터페이스 / 진입점

- **`coalesceFrames(bucket: AnalysisFrame[]): AnalysisFrame`** — 배치의 마지막 프레임을 기준으로 합치되, `temperatureMax`/`excursionMin`/`excursionMax`는 배치 전체에서 다시 계산합니다.
- **`detectEvents(bucket: AnalysisFrame[], prevTemp: number | null, thresholds?: TempThresholds): AnalysisFrame[]`** — 기본 임계값은 `DEFAULT_TEMP_WARN`(65) / `DEFAULT_TEMP_DANGER`(75). 임계 통과·변위 피크 프레임에 `isEvent`를 표시해 돌려줍니다.
- **`computeExcursionYRange(rawMin, rawMax, toDisplayUnit, scalePadding)`** / **`computeTemperatureYRange(dataMin, dataMax)`** — y축 표시 범위(`{yMin, yMax}`)를 반환합니다.
- **`symmetricYRange(peak: number, minSpan: number): [number, number]`** — 파형용 ±(peak×1.1) 대칭 범위. 최소 폭은 `minSpan`으로 보장합니다.
- **`class ChartStore extends VersionedSnapshotStore<ChartSnapshot>`** — `push(frame)`(알림 없이 적재) → `flush()` 순으로 쓰고 `readRange(metric, minSec, maxSec, maxPoints, out, transform?)`로 뷰포트 구간을 컬럼당 min/max 2점으로 압축해 `out`에 채웁니다(반환값은 쓴 포인트 수). `valueAt(metric, timeSec)`은 가장 가까운 점의 값(툴팁용), `seed(frames)`는 캐시 복원용 일괄 적재, `toFrames()`는 압축된 표시 데이터의 배열화입니다. `snapshot()`은 카운트·마지막 값·누적 극값·`pointInterval`·`firstX`/`lastX` 스칼라만 돌려줍니다. 점 상한은 `MAX_CHART_POINTS`(30000) — 도달하면 2:1 압축 후 시간 버킷 폭을 2배로 키워 이후 `push`를 버킷 안에서 병합합니다.
- **`class ChannelWaveStore extends VersionedSnapshotStore<WaveSnapshot>`** — 주 경로는 `addSamples(src: PcmSource, { channels, channel, frames, startSec, sampleRate })`: 인터리브 원본에서 사전 채널 추출 없이 pcm-kit 커널로 벌크 집계합니다(`addBlock(data, startSec, sampleRate)`은 mono 래퍼). 읽기는 `readRange(minSec, maxSec, maxPoints, out)`/`valueAt(timeSec)`. 버킷 상한 `MAX_WAVE_BUCKETS`(50000, export) 도달 시 버킷 폭을 2배로 압축합니다. 초기 버킷 폭은 0.005초(`setInitialBucketSec()`로 변경 가능). `snapshot()`이 `peak`/`rms`/`sampleCount`/`durationSec`까지 돌려주므로 별도 통계 함수가 필요 없습니다. 콘솔 `__ironPerf.envelopeMode("legacy")`를 켠 측정 빌드에서만 pcm-kit 도입 전 2-pass 경로로 우회합니다(A/B 비교용).
- **`readRawWindow(snap: CaptureSnapshot, channel, minSec, maxSec, out): number`** — 확대 구간의 원시 int16 샘플을 `INT16_SCALE`로 정규화해 `out`에 채웁니다. 버킷 해상도보다 깊이 확대했을 때만 의미가 있습니다.
- **`class AnnotationStore extends SubscribableStore`** — `setDraft(point | null)`/`addSegment({a, b})`/`getSegments()`/`getDraft()`/`clear()`/`isEmpty`. 스냅샷 없이 변경 알림만 제공합니다.
- **`createReadBuffer(points = 8192): SeriesReadBuffer`** / **`SEED_PX_WIDTH`**(1024) — 읽기 버퍼 생성과, view가 없을 때의 시드 픽셀 폭.
- **`channelLabel(ch, roles: ChannelRoleLabels): { name, role }`** / **`channelColor(ch)`** — 채널 0은 voltage, 1은 current, 그 외는 extended 역할로 매핑하며 역할 문구는 호출자가 주입합니다.
- **`buildMetricChartOptions(config: MetricChartOptionsConfig): UPlotOptions`** — legend 숨김, 커서 드래그, 시리즈 스타일, zoom+tooltip 플러그인까지 포함한 uPlot 옵션을 한 번에 만듭니다. `tooltipResolve`(스토어 `valueAt`을 읽는 가상 시리즈), `getFullXRange`, `extraPlugins`를 옵션으로 받습니다.
- **`buildTimeAxis()`** / **`buildValueAxis({ size })`** / **`buildAreaFill(topColor, bottomColor)`** — 축·그라디언트 빌더. 축 라벨 소수점은 `timeDecimalsForScale(u)`/`valueDecimalsForScale(u)`가 현재 줌 스팬에서 계산하고 `formatTimeValue(value, decimals)`가 `"1.234s"` 형태로 포맷합니다. `buildAreaFill`은 bbox가 같으면 그라디언트를 재사용합니다.
- **`zoomPlugin(opts?: { getFullXRange?, minXRange? })`** — 휠 줌(1회당 0.75배)·더블클릭 리셋. setScale을 rAF로 배칭하고 전체 범위의 99.5%를 넘으면 풀 범위로 스냅합니다. `getFullXRange`를 생략하면 현재 로드된 데이터의 extent를 전체 범위로 씁니다.
- **`tooltipPlugin(opts: TooltipOptions)`** — `unit`/`decimals`에 더해 `virtualSeries`(데이터 컬럼 대신 `resolve(timeSec)`로 값을 읽는 시리즈)를 지원합니다.
- **`thresholdsPlugin(lines: ThresholdLine[])`** — y 임계선 + 우측 라벨. 현재 y범위 밖의 선은 건너뜁니다.
- **`annotatePlugin({ store, isEnabled, color? })`** — 클릭 두 번으로 세그먼트를 잇는 주석 플러그인. 스냅은 커서 idx의 첫 표시 시리즈 값 기준이고 Escape로 드래프트를 취소합니다.
- **`envelopeOverlayPlugin(channels: { store: ChannelWaveStore, seriesIdx }[])`** — uPlot 데이터 배열 밖에서 `ChannelWaveStore`를 캔버스에 직접 스트로크합니다. 스토어 구독은 dirty 플래그만 세우고 실제 redraw는 `frameScheduler`의 draw 페이즈에서 병합 실행됩니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. ECharts 기반 `chart-option.ts`에서 uPlot 기반(`chart-store`/`wave-store`/`envelope`/`uplot-option`/`uplot-plugins`/`metric-chart-options`)으로 전환을 이미 마친 상태를 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: 뷰포트 기반 읽기로 전환 — 정렬 컬럼 전체를 만들던 `readAligned()`를 없애고 x구간+픽셀 폭 예산의 `readRange()`로 교체, 상한을 점 30000개/버킷 50000개로 확대. `store-base.ts`(구독/스냅샷 베이스)·`read-buffer.ts`·`raw-window.ts`·`annotation-store.ts` 신설, `uplot-plugins.ts`를 `uplot-plugins/` 5파일로 분리(annotate·envelope-overlay 추가). `ChannelWaveStore`는 pcm-kit WASM 커널 벌크 집계로 전환(+`__ironPerf.envelopeMode` 레거시 A/B 경로). `envelope.ts`/`waveform.ts`/`capture-reader.ts`/`types.ts` 삭제 — 통계는 `WaveSnapshot`으로 흡수 (커밋 범위: 4d86f32..24d1daa)
