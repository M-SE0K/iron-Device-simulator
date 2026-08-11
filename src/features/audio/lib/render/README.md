# render

## 1. 도메인 설명

실시간 차트·파형을 그리는 데 필요한 순수 계산을 모아둔 도메인입니다. 화면 표시 전용 상태를 React 밖에서 들고 있는 스토어도 여기 있습니다. 세션이 아무리 길어져도 표시 데이터의 메모리·렌더 비용이 늘지 않도록 점 개수를 상한선에서 압축하는 전략(`ChartStore`, `ChannelWaveStore`)이 들어 있고, 화면에 보이는 구간만 골라 내보내는 뷰포트 읽기(`readRange`, `readRawWindow`)와 uPlot 차트가 공통으로 쓰는 축·줌·툴팁·임계선·주석 플러그인도 이 도메인이 제공합니다.

## 2. 프로젝트 전반에서의 역할

`dashboard/`·`chart/`·`channel/`·`workspace/` 네 도메인이 공통으로 기대는 렌더링 인프라입니다. 분석 엔진이 만든 원본 프레임 전체는 다른 곳(`DashboardClient`의 `allFramesRef`)이 그대로 들고 있습니다. 이 도메인이 책임지는 건 화면에 무엇을 얼마나 그릴지뿐입니다. 저장이나 CSV/JSON 내보내기에는 관여하지 않습니다.

읽기 경로는 두 단계입니다. 축소해서 볼 때는 스토어가 압축해 둔 요약본(점 상한·버킷 min/max)을 읽습니다. 픽셀당 샘플 수가 1 근처까지 확대되면 `readRawWindow()`가 캡처 세션의 원본 PCM에서 해당 구간만 직접 읽습니다. 두 경로 모두 한 번에 내보내는 점 수가 화면 폭에 묶여 있어 호출 비용이 세션 길이와 무관합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `types.ts` | `QueuedFrame`(프레임 한 개를 감싸는 큐 항목) 타입 |
| `coalesce.ts` | 큐에 쌓인 프레임 여러 개를 하나로 합치는 `coalesceFrames()` |
| `detect-events.ts` | 온도 WARN/DANGER 임계 통과·변위 피크를 감지하는 `detectEvents()`, 기본 임계값 상수 |
| `chart-window.ts` | 온도/변위/파형 차트의 y축 표시 범위 계산 |
| `chart-store.ts` | 메인 Temperature/Excursion 차트의 표시 데이터 스토어 `ChartStore` — 점 30,000개 상한으로 압축하며 React 커밋 없이 구독자에게 직접 알림 |
| `wave-store.ts` | 채널 파형 하나의 min/max 엔벨로프 스토어 `ChannelWaveStore` — 버킷 50,000개 상한으로 압축 |
| `read-buffer.ts` | 스토어가 뷰포트를 채워 내보낼 때 쓰는 출력 버퍼 `SeriesReadBuffer` — 호출자가 소유·재사용 |
| `raw-window.ts` | 캡처 세션 원본 PCM에서 구간 한 채널을 그대로 읽는 `readRawWindow()`(확대 뷰 전용) |
| `annotation-store.ts` | 차트 위 점 잇기 주석(데이터 좌표 선분)의 스토어 `AnnotationStore` |
| `envelope.ts` | 오프라인으로 디코드한 전체 파형(원본/보호 감쇠 비교용)의 min/max 엔벨로프 `BucketEnvelope`와 uPlot 컬럼 헬퍼 |
| `protected-series.ts` | 보호 감쇠 비교 패널의 Input(무채색)/Protected(유채색) L·R 색상 상수 |
| `waveform.ts` | peak/rms 통계 `channelStats()` |
| `channel-meta.ts` | 채널 번호 → 표시 이름·역할(V/I/Extended)·색상 매핑 |
| `metric-chart-options.ts` | Temperature/ExcursionChart가 공유하는 uPlot 시리즈/옵션 빌더 |
| `uplot-option.ts` | 시간/값 축 빌더, 시각 라벨 포맷, 영역 채우기 그라디언트 |
| `uplot-plugins/zoom.ts` | 휠 줌 + 더블클릭 리셋 보정, 확대 하한(`minXRange`) |
| `uplot-plugins/tooltip.ts` | 커서 추적 툴팁. `virtualSeries`로 `u.data[]`에 없는 시리즈도 함께 표시 |
| `uplot-plugins/annotate.ts` | 점 잇기 주석 플러그인 — 클릭 두 번으로 데이터 포인트를 직선으로 연결 |
| `uplot-plugins/thresholds.ts` | y=임계값(WARN/DANGER) 점선 + 라벨 |
| `uplot-plugins/static-layer.ts` | 변하지 않는 시리즈를 별도 캔버스에 캐시해 재사용하는 `staticSeriesLayerPlugin()` |
| `uplot-plugins/live-envelope-overlay.ts` | `ChannelWaveStore`를 직접 읽어 캔버스에 그리는 라이브 오버레이 — `setData()` 비용을 건너뜀 |
| `uplot-plugins/index.ts` | 위 여섯 플러그인의 재수출 배럴 |

## 4. 의존성 및 흐름

- **가져오는 것**: `features/audio/types`의 `AnalysisFrame`, `@/shared/components/UPlotChart`의 `UPlotOptions` 타입, `uplot` 라이브러리 자체. `raw-window.ts` 하나만 예외로 두 곳을 더 참조합니다 — `lib/engine/core`의 `INT16_SCALE`(int16 → [-1,1] 정규화 계수)와 `player/capture/types`의 `CaptureSnapshot` 타입입니다. 원본 PCM을 들고 있는 주체가 캡처 세션이니 그 스냅샷 모양을 알아야 합니다.
- **소비하는 도메인**:
  - `dashboard/` — `DashboardClient.tsx`가 `coalesceFrames`/`detectEvents`로 출력 큐를 배치 처리한 결과를 `ChartStore.push()`에 넣습니다. `AnnotationStore`와 채널별 `ChannelWaveStore`도 세션 단위로 여기가 소유합니다. 그 스토어들은 `DashboardViewGrid`/`ChannelChartCard`가 카드에 내려보내고 `hooks/useFrameCachePersistence.ts`는 `ChartStore`를 직접 다룹니다.
  - `chart/` — `TemperatureChart`/`ExcursionChart`와 그 훅들(`useMetricChartSource`/`useMetricChartRuntime`/`useChartFullXRange`/`useDrawMode`)이 `chart-store`/`chart-window`/`read-buffer`/`metric-chart-options`/`uplot-plugins`/`annotation-store`를 가져다 씁니다.
  - `channel/` — `ChannelWaveformCanvas`는 `wave-store`/`raw-window`/`read-buffer`/`annotation-store`/`chart-window`/`uplot-option`/`uplot-plugins`를 씁니다. `ProtectedComparePanel`은 `envelope`/`protected-series`/`wave-store`/`chart-window`/`uplot-option`/`uplot-plugins`를 씁니다. `hooks/useChannelWaveStreams`가 쓰는 건 `wave-store` 하나입니다.
  - `workspace/` — `ChannelViewerOverlay`가 `wave-store`/`waveform`/`channel-meta`를 씁니다.
  - `calibration/` — `calibration-options.ts`가 `detect-events`의 기본 온도 임계값 상수를 재사용합니다.

```
엔진 프레임 → coalesceFrames/detectEvents(배치 처리) → ChartStore.push() → flush()
    → (rAF) 구독 중인 차트가 readRange(보이는 구간, 점 예산, 출력 버퍼)로 uPlot에 커밋

채널 캡처 청크 → ChannelWaveStore.addBlock() → flush()
    → (rAF) 축소 뷰: readAligned() 또는 liveEnvelopeOverlayPlugin이 직접 그리기
            확대 뷰: readRawWindow(캡처 스냅샷, 채널, 구간, 출력 버퍼)로 원본 샘플 읽기

오프라인 디코드(원본 파형 / 보호 감쇠 비교) → BucketEnvelope.add()
    → buildBucketXs() + fillEnvelopeColumn()으로 uPlot 컬럼 구성

차트 클릭(그리기 모드) → annotatePlugin이 최근접 데이터 포인트에 스냅
    → AnnotationStore.addSegment() → 구독 중인 플러그인이 즉시 redraw
```

## 5. 주요 인터페이스 / 진입점

- **`coalesceFrames(bucket: QueuedFrame[]): AnalysisFrame`** — 배치 안 프레임들을 마지막 값 기준으로 합치되, 온도 최댓값·변위 최소/최댓값은 배치 전체에서 다시 계산합니다.
- **`detectEvents(bucket, prevTemp: number | null, thresholds?: TempThresholds): QueuedFrame[]`** — 기본 임계값은 `DEFAULT_TEMP_WARN`(65) / `DEFAULT_TEMP_DANGER`(75). 임계 통과·변위 피크에 해당하는 프레임만 돌려주며 그 프레임 자체에 `isEvent`/`eventType`을 표시해 둡니다.
- **`createReadBuffer(points?: number): SeriesReadBuffer`** — `{ xs, ys }` Float64Array 한 쌍을 만듭니다. 기본 8,192점(픽셀 열 4,096개 × 2점, 한 쌍당 128 KB)이고 **호출자가 소유·재사용합니다**. 스토어가 내부 버퍼의 뷰를 내보내지 않는 이유가 여기 있습니다 — 다음 `push`/`addBlock`/`compact`가 그 자리에서 값을 바꿔 버립니다.
- **`class ChartStore`** — `push(frame)`(알림 없이 적재) → `flush()`(구독자에게 알림) 순으로 씁니다. 점 개수 상한은 `MAX_CHART_POINTS`(30,000)이고, 가득 차면 인접 두 점을 합치며 버킷 폭을 두 배로 늘립니다.
  - **`readRange(metric, minSec, maxSec, maxPoints, out, transform?): number`** — 보이는 구간을 최대 `maxPoints`개 점으로 `out`에 채우고 채운 개수를 돌려줍니다. 픽셀 열마다 최소·최대인 **실제 점** 두 개를 원래 순서대로 골라 내므로 피크가 깎이지 않고 툴팁·주석도 진짜 측정 시각에 붙습니다. ⚠️ `transform`은 단조 증가 함수여야 합니다 — 극값은 원본 값으로 찾고 변환은 내보낼 점에만 적용하기 때문입니다.
  - **`snapshot(): ChartSnapshot`** — 배열 복사가 없는 스칼라만 돌려줍니다. `count`/`sourceCount`(감량 전 프레임 수)/`lastTemperature`/`lastExcursion`/누적 극값 4개/`pointInterval`(점 하나가 대표하는 초)/`firstX`·`lastX`(전체 x 도메인의 양 끝, 점이 없으면 `null`)입니다. 뷰포트만 커밋하므로 줌 판정과 줌아웃 복원은 `u.data`의 extent가 아니라 이 `firstX`/`lastX`를 기준으로 해야 합니다.
  - **`seed(frames: AnalysisFrame[])`** — 리셋 후 프레임 배열을 한 번에 적재하고 `flush()`까지 수행합니다(캐시 복원용).
- **`class ChannelWaveStore`** — `addBlock(data, startSec, sampleRate)` → `flush()`, `readAligned()`로 min/max 엔벨로프 컬럼(`[Float64Array, Float64Array]`)을 얻습니다. 버킷 상한은 `MAX_WAVE_BUCKETS`(50,000), 초기 버킷 폭은 `INITIAL_BUCKET_SEC`(0.005초)이라 첫 압축은 250초 지점에서 일어납니다. `readAligned()`는 내부 버퍼가 아니라 **복사본**을 돌려줍니다 — 길이가 상한에 묶여 있어 복사 비용이 세션 길이와 무관합니다. `snapshot(): WaveSnapshot`은 `bucketCount`/`durationSec`/`bucketSec`/누적 `peak`·`rms`/`sampleCount`를 줍니다.
- **`readRawWindow(snap: CaptureSnapshot, channel, minSec, maxSec, out): number`** — 캡처 세션 원본 PCM에서 해당 구간의 한 채널 샘플을 `[-1, 1]`로 정규화해 `out`에 채우고 채운 개수를 돌려줍니다. 엔벨로프는 버킷 폭 아래로 내려가지 못하므로, 개별 샘플(48 kHz에서 1샘플 = 20.83 µs)까지 확대할 때만 이 경로를 씁니다. 채널 번호가 범위를 벗어나거나 프레임이 없으면 0을 돌려줍니다.
- **`class AnnotationStore`** — `subscribe(cb)`/`addSegment(seg)`/`removeLast()`/`setDraft(point | null)`/`clear()`, 읽기는 `getSegments()`/`getDraft()`/`getVersion()`/`count`/`isEmpty`. 좌표를 픽셀이 아니라 **데이터 값**(x=초, y=시리즈 값)으로 저장하므로 줌·리사이즈 후에도 선이 데이터 포인트에 붙어 있습니다. 세션이 리셋되면 대시보드가 `clear()`합니다.
- **`computeSymmetricYRange(peak, minSpan, padding): [number, number]`** / **`computeExcursionYRange(rawMin, rawMax, toDisplayUnit, scalePadding)`** / **`computeTemperatureYRange(dataMin, dataMax)`** — y축 표시 범위. 앞의 것은 0을 중심으로 대칭인 파형용이라 튜플을, 뒤의 둘은 `{ yMin, yMax }`를 돌려줍니다.
- **`class BucketEnvelope`** — `add(bucket, value)`로 버킷별 min/max를 누적하고 `peak()`로 절대 피크, `clear()`로 초기화합니다. `min`/`max`/`seen` 배열과 `filledUpTo`를 직접 읽을 수 있습니다. uPlot 컬럼으로 옮길 때는 **`buildBucketXs(buckets, durationSec)`**(x 컬럼)와 **`fillEnvelopeColumn(env, out?)`**(y 컬럼, `out`을 주면 재사용), 빈 컬럼이 필요하면 **`emptyEnvelopeColumn(buckets)`**를 씁니다.
- **`channelStats(data: Float32Array): { peak, rms }`** — 배열 전체의 피크/RMS를 계산합니다.
- **`channelLabel(ch: number, roles: ChannelRoleLabels): { name, role }`** / **`channelColor(ch: number)`** — 채널 0은 V, 1은 I, 그 외는 Extended로 표시하고 채널마다 고정 색상을 줍니다. 이 모듈은 표시 문자열을 들고 있지 않습니다 — 역할 이름은 호출자가 `roles`(`voltage`/`current`/`extended`)로 넘깁니다.
- **`buildMetricChartOptions(config: MetricChartOptionsConfig): UPlotOptions`** — legend 숨김, 커서 드래그, 시리즈 스타일, zoom+tooltip 플러그인까지 포함한 uPlot 옵션을 한 번에 만듭니다. `getFullXRange`와 `extraPlugins`(예: 온도의 임계선)만 메트릭별로 다릅니다.
- **`buildTimeAxis()`** / **`buildValueAxis(opts)`** / **`buildAreaFill(topColor, bottomColor)`** — 축·그라디언트 빌더. 시간 축은 **항상 초 단위**이고 소수점 자리수만 현재 보이는 폭에 맞춰 늘립니다(상한 6자리 = 1 µs). 축과 툴팁이 같은 문자열을 쓰도록 **`timeDecimalsForScale(u)`** → **`formatTimeValue(value, decimals)`**를 함께 노출합니다.
- **`zoomPlugin(opts?: { getFullXRange?, minXRange? })`** — `getFullXRange`를 생략하면 현재 로드된 데이터의 extent를 전체 범위로 씁니다. `minXRange`는 확대 하한(x 범위의 최소 폭)이라 원본 샘플까지 내려가는 파형에서 `16 / sampleRate`처럼 줍니다. ⚠️ 두 옵션 모두 uPlot 옵션 객체에 박히므로 **참조가 안정된 함수**로 넘겨야 합니다 — 매 렌더 새 함수를 넘기면 인스턴스가 재생성되며 줌 상태를 잃습니다.
- **`tooltipPlugin(opts: TooltipOptions)`** — `unit`/`decimals`에 더해 `virtualSeries`를 받습니다. `u.data[]`에 실데이터가 없는 시리즈(라이브 오버레이 등)를 `resolve(timeSec)` 훅으로 툴팁에 함께 실을 때 씁니다.
- **`thresholdsPlugin(lines: ThresholdLine[])`** — `{ y, color, label }` 목록을 y=상수 점선 + 우측 정렬 라벨로 그립니다. 현재 y 범위를 벗어난 선은 건너뜁니다.
- **`annotatePlugin(opts: { store, isEnabled, color? })`** — 그리기 모드에서 클릭 두 번으로 데이터 포인트를 직선으로 잇습니다. 클릭은 `u.cursor.idx`(최근접 데이터 인덱스)에 스냅되고, 같은 점을 다시 클릭하거나 ESC를 누르면 취소됩니다. mousedown과 click 사이 이동량이 4 px을 넘으면 드래그(영역 줌)로 보고 무시하므로 기존 줌 조작과 공존합니다. `isEnabled`도 참조가 안정된 함수여야 합니다.
- **`staticSeriesLayerPlugin(seriesIdx: readonly number[])`** — 지정한 시리즈를 별도 캔버스에 한 번 그려 두고, 캔버스 크기·스케일·표시 여부·데이터 참조가 그대로면 그 결과를 재사용합니다. 정적인 원본 파형과 라이브 시리즈가 같은 인스턴스를 공유할 때 정적 쪽 재그리기 비용을 없앱니다.
- **`liveEnvelopeOverlayPlugin(channels: readonly LiveEnvelopeChannel[])`** — `{ store, seriesIdx }` 목록을 받아, `u.setData()`를 거치지 않고 `ChannelWaveStore`를 직접 읽어 캔버스에 그립니다. `u.data[seriesIdx]`는 빈 플레이스홀더이고 색상·표시 토글만 그 시리즈에서 빌려옵니다. 점은 uPlot 기본 규칙과 같게 평균 간격이 `points.space`(기본 10 CSS px)보다 촘촘하면 그리지 않습니다.
- **보호 감쇠 비교 색상** — `COLOR_INPUT_L`(`#475569`) / `COLOR_INPUT_R`(`#94A3B8`)는 무채색, `COLOR_PROTECTED_L`(`#2563eb`) / `COLOR_PROTECTED_R`(`#d97706`)는 유채색입니다. 원본은 배경 기준선으로 물러나고 보호 결과만 색으로 떠오르게 하는 배치이고, L/R은 채도가 아니라 명도 두 단계로 구분합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. ECharts 기반 `chart-option.ts`에서 uPlot 기반(`chart-store`/`wave-store`/`envelope`/`uplot-option`/`uplot-plugins`/`metric-chart-options`)으로 전환을 이미 마친 상태를 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-11: 뷰포트 렌더·주석·플러그인 분해 반영. `uplot-plugins.ts` 단일 파일을 `uplot-plugins/` 6개 모듈(`zoom`/`tooltip`/`annotate`/`thresholds`/`static-layer`/`live-envelope-overlay`)과 배럴로 나눴다. 신규 `read-buffer.ts`(호출자 소유 출력 버퍼)·`raw-window.ts`(원본 PCM 확대 읽기)·`annotation-store.ts`(점 잇기 주석)·`protected-series.ts`(비교 패널 색상)를 추가하고 `capture-reader.ts`는 삭제했다. `ChartStore.readAligned()`는 뷰포트 기반 `readRange()`로 바뀌었다. 점 상한은 5,000 → 30,000, `ChannelWaveStore` 버킷 상한은 1,000 → 50,000으로 올랐다. `BucketEnvelope`는 `envelopesToAligned()` 대신 `buildBucketXs`/`fillEnvelopeColumn`/`emptyEnvelopeColumn`을 쓴다. `buildTimeAxis()`는 인자를 받지 않는다. `timeDecimalsForInterval()`은 `timeDecimalsForScale()`/`formatTimeValue()`로 대체됐다. `channelLabel()`은 역할 표시 문자열을 직접 갖지 않고 `roles` 인자로 받는다. `chart-window.ts`에는 `computeSymmetricYRange()`가 생겼다. `QueuedFrame`에서 수신 시각 필드가 빠졌다. `raw-window.ts` 때문에 이 도메인이 `lib/engine/core`와 `player/capture/types`를 처음으로 참조한다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: 4d86f32..HEAD, 작업 트리 포함)
