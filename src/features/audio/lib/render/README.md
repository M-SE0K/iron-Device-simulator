# render

## 1. 도메인 설명

실시간 차트·파형을 그리는 데 필요한 순수 계산, 그리고 화면 표시 전용 상태를 React 밖에서 들고 있는 스토어를 모아둔 도메인입니다. 세션이 아무리 길어져도 표시 데이터의 메모리·렌더 비용이 늘지 않게 점 개수를 상한선에서 압축하는 전략(`ChartStore`, `ChannelWaveStore`)을 담고 있고, uPlot 차트가 공통으로 쓰는 축·줌·툴팁·임계선 설정도 여기서 제공합니다.

## 2. 프로젝트 전반에서의 역할

`dashboard/`·`chart/`·`channel/`·`workspace/` 네 도메인이 공통으로 기대는 렌더링 인프라입니다. 분석 엔진이 만든 원본 프레임 전체는 다른 곳(`DashboardClient`의 `allFramesRef`)이 그대로 보존하므로, 이 도메인은 화면에 무엇을 얼마나 그릴지만 책임집니다. 저장이나 CSV/JSON 내보내기에는 관여하지 않습니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `types.ts` | `QueuedFrame`(프레임 + 수신 시각) 타입 |
| `coalesce.ts` | 큐에 쌓인 프레임 여러 개를 하나로 합치는 `coalesceFrames()` |
| `detect-events.ts` | 온도 WARN/DANGER 임계 통과·변위 피크를 감지하는 `detectEvents()`, 기본 임계값 상수 |
| `chart-window.ts` | 온도/변위 차트의 y축 표시 범위 계산 |
| `chart-store.ts` | 메인 Temperature/Excursion 차트의 표시 데이터 스토어 `ChartStore` — 점 5000개 상한으로 압축하며 React 커밋 없이 구독자에게 직접 알림 |
| `wave-store.ts` | 채널 파형 하나의 min/max 엔벨로프 스토어 `ChannelWaveStore` — 버킷 1000개 상한으로 압축 |
| `envelope.ts` | 오프라인으로 디코드한 전체 파형(원본/보호 감쇠 비교용)의 min/max 엔벨로프 `BucketEnvelope`와 uPlot 정렬 헬퍼 |
| `waveform.ts` | peak/rms 통계 `channelStats()` |
| `channel-meta.ts` | 채널 번호 → 표시 이름·역할(V/I/Extended)·색상 매핑 |
| `metric-chart-options.ts` | Temperature/ExcursionChart가 공유하는 uPlot 시리즈/옵션 빌더 |
| `uplot-option.ts` | 시간/값 축 빌더, 영역 채우기 그라디언트 |
| `uplot-plugins.ts` | 휠 줌(+더블클릭 리셋 보정)·툴팁·임계선 uPlot 플러그인 |

## 4. 의존성 및 흐름

- **가져오는 것**: `features/audio/types`의 `AnalysisFrame`, `@/shared/components/UPlotChart`의 `UPlotOptions` 타입, `uplot` 라이브러리 자체.
- **소비하는 도메인**:
  - `dashboard/` — `DashboardClient.tsx`가 `coalesceFrames`/`detectEvents`로 출력 큐를 배치 처리한 결과를 `ChartStore.push()`에 넣습니다. `hooks/useFrameCachePersistence.ts`도 `ChartStore`를 직접 다룹니다.
  - `chart/` — `TemperatureChart`/`ExcursionChart`/`ChartDetailOverlay`와 그 훅들이 `chart-store`/`chart-window`/`metric-chart-options`/`uplot-option`/`uplot-plugins`/`channel-meta`를 가져다 씁니다.
  - `channel/` — `ProtectedComparePanel`/`ChannelWaveformCanvas`가 `uplot-option`/`uplot-plugins`/`wave-store`/`envelope`를 씁니다.
  - `workspace/` — `ChannelViewerOverlay`가 `wave-store`/`waveform`/`channel-meta`를 씁니다.
  - `calibration/` — `calibration-options.ts`가 `detect-events`의 기본 온도 임계값 상수를 재사용합니다.

```
엔진 프레임 → coalesceFrames/detectEvents(배치 처리) → ChartStore.push()
    → (rAF) 구독 중인 차트가 readAligned()로 uPlot에 커밋

채널 캡처 청크 → ChannelWaveStore.addBlock() → (rAF) ChannelWaveformCanvas가 readAligned()로 커밋

오프라인 디코드(원본 파형 / 보호 감쇠 비교) → BucketEnvelope.add() → envelopesToAligned()로 커밋
```

## 5. 주요 인터페이스 / 진입점

- **`coalesceFrames(bucket: QueuedFrame[]): AnalysisFrame`** — 배치 안 프레임들을 마지막 값 기준으로 합치되, 온도 최댓값·변위 최소/최댓값은 배치 전체에서 다시 계산합니다.
- **`detectEvents(bucket, prevTemp: number | null, thresholds?: TempThresholds): QueuedFrame[]`** — 기본 임계값은 `DEFAULT_TEMP_WARN`(65) / `DEFAULT_TEMP_DANGER`(75). 임계 통과·변위 피크에 해당하는 프레임만 돌려주며 그 프레임 자체에 `isEvent`/`eventType`을 표시해 둡니다.
- **`computeExcursionYRange(rawMin, rawMax, toDisplayUnit, scalePadding)`** / **`computeTemperatureYRange(dataMin, dataMax)`** — y축 표시 범위(`{yMin, yMax}`)를 반환합니다.
- **`class ChartStore`** — `push(frame)`(알림 없이 적재) → `flush()`(구독자에게 알림) 순으로 쓰고, `readAligned(metric, transform?)`로 uPlot용 `[x, y]` 컬럼을 얻습니다. `snapshot()`은 카운트·마지막 값·누적 극값처럼 리렌더 비용이 없는 스칼라만 돌려줍니다. 점 개수 상한은 `MAX_CHART_POINTS`(5000)입니다.
- **`class ChannelWaveStore`** — `addBlock(data, startSec, sampleRate)` → `flush()`, `readAligned()`로 min/max 엔벨로프 컬럼을 얻습니다. 버킷 상한은 `MAX_WAVE_BUCKETS`(1000), 초기 버킷 폭은 `INITIAL_BUCKET_SEC`(0.005초)입니다.
- **`class BucketEnvelope`** — `add(bucket, value)`로 버킷별 min/max를 누적하고 `peak()`로 절대 피크를 구합니다. 여러 엔벨로프를 uPlot 컬럼 하나로 합칠 때는 **`envelopesToAligned(envs, durationSec)`**를 씁니다.
- **`channelStats(data: Float32Array): { peak, rms }`** — 배열 전체의 피크/RMS를 계산합니다.
- **`channelLabel(ch: number)`** / **`channelColor(ch: number)`** — 채널 0은 V, 1은 I, 그 외는 Extended로 표시하고 채널마다 고정 색상을 줍니다.
- **`buildMetricChartOptions(config: MetricChartOptionsConfig): UPlotOptions`** — legend 숨김, 커서 드래그, 시리즈 스타일, zoom+tooltip 플러그인까지 포함한 uPlot 옵션을 한 번에 만듭니다.
- **`buildTimeAxis(dataDecimals)`** / **`buildValueAxis(opts)`** / **`buildAreaFill(topColor, bottomColor)`** / **`timeDecimalsForInterval(intervalSec)`** — 축·그라디언트 빌더.
- **`zoomPlugin(opts?: { getFullXRange? })`** / **`tooltipPlugin(opts: TooltipOptions)`** / **`thresholdsPlugin(lines: ThresholdLine[])`** — uPlot 플러그인. `getFullXRange`를 생략하면 스트리밍 메인 차트처럼 현재 로드된 데이터의 extent를 전체 범위로 씁니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. ECharts 기반 `chart-option.ts`에서 uPlot 기반(`chart-store`/`wave-store`/`envelope`/`uplot-option`/`uplot-plugins`/`metric-chart-options`)으로 전환을 이미 마친 상태를 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
