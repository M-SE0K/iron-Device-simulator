# render

## 1. 도메인 설명

엔진이 뿜어내는 분석 프레임(약 100 Hz)을 화면이 감당할 수 있는 형태로 다듬는 순수 함수 모음이다. 개발자는 이 도메인 하나만 보면 "프레임 병합 → 이벤트 감지 → 표시 윈도우/축 계산 → ECharts 옵션 조립"이라는 렌더 전처리 파이프라인 전체를 파악할 수 있다. 원래 `DashboardClient.tsx`와 `TemperatureChart.tsx`/`ExcursionChart.tsx`에 각각 중복 구현돼 있던 로직을 React 상태와 분리해 뽑아낸 것으로, 모든 함수가 부수효과 없는 순수 함수다(단, `detectEvents`는 인자로 받은 bucket 배열의 요소를 제자리 교체한다 — 5절 참고).

## 2. 프로젝트 전반에서의 역할

이 프로젝트는 "입력 PCM 프레임은 절대 버리지 않는다"는 제약(온도 모델이 상태 누적형) 아래에서 모든 최적화를 클라이언트 출력 큐와 렌더 경로에서만 한다. 그 렌더 경로의 계산 파트가 바로 이 도메인이다.

- `DashboardClient.tsx`의 출력 큐 스케줄러(`RENDER_INTERVAL` 16 ms)가 큐에 쌓인 프레임 bucket을 `detectEvents()` → `coalesceFrames()` 순으로 통과시켜 차트 버퍼(`streamingFrames`)에 넣는다.
- `TemperatureChart.tsx`/`ExcursionChart.tsx`는 그 버퍼를 받아 `chart-window.ts`로 표시 윈도우와 Y축 범위를 계산하고 `chart-option.ts`로 공통 ECharts 옵션 조각을 조립한다.
- `DEFAULT_TEMP_WARN`(65 °C)/`DEFAULT_TEMP_DANGER`(75 °C)는 이벤트 감지(`detectEvents`), `TemperatureChart`의 markLine, `CalibrationContext`의 기본값이 모두 공유하는 단일 진실원이다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `types.ts` | 출력 큐 단위 타입 `QueuedFrame`(`{ frame: AnalysisFrame; recvAt: number }`) 정의. `coalesce.ts`/`detect-events.ts`의 공용 입력 타입 |
| `coalesce.ts` | bucket에 쌓인 여러 프레임을 요약 프레임 1개로 병합하는 `coalesceFrames()`. 최신 프레임 값을 대표값으로 쓰고 구간 내 `temperatureMax`/`excursionMin`/`excursionMax` envelope와 `sourceCount`/`timeStart`/`timeEnd`를 보존한다 |
| `detect-events.ts` | 온도 임계 교차(WARN/DANGER, 양방향)와 익스커션 피크(앞뒤 프레임보다 절대값이 큰 극값)를 감지하는 `detectEvents()`. 기본 임계값 상수 `DEFAULT_TEMP_WARN`(65)/`DEFAULT_TEMP_DANGER`(75)와 `TempThresholds` 타입의 정의처 |
| `chart-window.ts` | 두 차트 공용의 표시 윈도우 계산 `computeStreamWindow()`와, 지표별로 알고리즘이 다른 Y축 동적 범위 계산 `computeExcursionYRange()`(대칭 패딩)/`computeTemperatureYRange()`(0~100 °C 기본, 10/25/50/100 단위 확장). `ChannelMode`(`"L" \| "R" \| "Both"`) 타입과 두 차트 공용 표시 윈도우 프레임 수 `WINDOW_SIZE`(1000) 정의처 |
| `chart-option.ts` | 두 차트가 동일하게 쓰던 ECharts 옵션 조각 빌더. 축·툴팁 조각(`buildDataZoom()`(inside+slider)/`buildValueTooltip()`(단위·소수점 지정))과 시간 포맷 헬퍼(`timeDecimalsForInterval`/`resolveTimeDecimals`/`buildDynamicTimeFormatter`), series·Y축·옵션 골격(`buildLineSeries()`/`buildValueYAxis()`/`buildAreaGradient()`/`buildBaseChartOption()`)이 있다. 시간축(`buildTimeAxis`)·범례(`buildLegend`)는 골격 조립기가 내부에서만 쓰므로 export하지 않는다. 확대(zoom) 시 프레임 점 표시 여부를 판정하는 `shouldShowFrameSymbols()`와 그 상한 상수 `SYMBOL_VISIBLE_MAX`(80)도 여기서 export한다. 지표별로 다른 부분(색·smooth·폭·markLine·grid 좌측 여백·심볼 표시)만 각 차트가 인자로 넘긴다 |

## 4. 의존성 및 흐름

**이 도메인이 import하는 것 (들어오는 의존)**

- `@/features/audio/types` → `AnalysisFrame` 타입 (`types.ts`, `coalesce.ts`, `chart-window.ts`, `chart-option.ts`)
- `@/shared/lib/utils` → `findFrameIndex()` (`chart-window.ts`의 비스트리밍 seek 위치 탐색)
- 내부: `chart-option.ts` → `chart-window.ts`(`ChannelMode`), `coalesce.ts`/`detect-events.ts` → `types.ts`(`QueuedFrame`)

**이 도메인을 import하는 곳 (나가는 의존)**

- `components/dashboard/DashboardClient.tsx` → `coalesceFrames`, `detectEvents`, `DEFAULT_TEMP_WARN`/`DEFAULT_TEMP_DANGER`, `TempThresholds`, `QueuedFrame`
- `components/chart/TemperatureChart.tsx` → `chart-window.ts`(`computeStreamWindow`/`computeTemperatureYRange`/`WINDOW_SIZE`), `chart-option.ts` 빌더 일체(series·값 축·그라디언트·골격 포함) + `shouldShowFrameSymbols`(줌 시 프레임 점 토글), `DEFAULT_TEMP_WARN`/`DEFAULT_TEMP_DANGER`(markLine)
- `components/chart/ExcursionChart.tsx` → `chart-window.ts`(`computeStreamWindow`/`computeExcursionYRange`/`WINDOW_SIZE`), `chart-option.ts` 빌더 일체 + `shouldShowFrameSymbols`
- `components/channel/ChannelWaveformCanvas.tsx` → `chart-option.ts`의 `buildDataZoom`/`buildValueTooltip`/`buildDynamicTimeFormatter`/`timeDecimalsForInterval`/`SYMBOL_VISIBLE_MAX`(채널 파형도 두 차트와 같은 줌·시간축·심볼 규약을 따른다)
- `components/calibration/CalibrationContext.tsx` → `DEFAULT_TEMP_WARN`/`DEFAULT_TEMP_DANGER`(calibration 기본값)

**내부 처리 흐름 (실시간 경로, `useQueue=true` 기준)**

```
엔진 frame 수신 → outputQueue(QueuedFrame[]) 적재
  → 16ms 스케줄러가 bucket 추출
  → detectEvents(bucket, prevTemp, thresholds)   # isEvent/eventType 마킹 (제자리 교체)
  → coalesceFrames(bucket)                       # 요약 프레임 1개 + envelope
  → setStreamingFrames → Temperature/ExcursionChart
      → computeStreamWindow() → windowFrames
      → computeTemperatureYRange() / computeExcursionYRange()
      → buildDataZoom/TimeAxis/ValueTooltip/Legend() → ECharts option
```

`detectEvents`가 `coalesceFrames`보다 먼저 실행되어야 한다 — 이벤트 마킹이 병합 결과에 반영되는 구조다.

## 5. 주요 인터페이스 / 진입점

- `coalesceFrames(bucket: QueuedFrame[]): AnalysisFrame` — bucket을 요약 프레임 1개로 병합. 길이 1이면 그대로 반환. 온도는 최신값 + 구간 최댓값(`temperatureMax`), 익스커션은 최신값 + min/max envelope(`excursionMin`/`excursionMax`)를 채운다. 주의: `detectEvents` 이후에 호출해야 이벤트 마킹이 반영된다.
- `detectEvents(bucket: QueuedFrame[], prevTemp: [number, number] | null, thresholds?: TempThresholds): QueuedFrame[]` — 온도 임계 교차(WARN/DANGER 각각 아래→위, 위→아래 양방향)와 익스커션 피크를 감지해 해당 `bucket[i].frame`을 `isEvent: true, eventType: "temp_warn" | "temp_danger" | "exc_peak"`가 채워진 새 객체로 제자리 교체하고 감지된 `QueuedFrame` 배열을 반환한다. `prevTemp`는 직전 렌더 사이클 마지막 온도(bucket 경계 교차 감지용). `thresholds` 생략 시 65/75 °C.
- `DEFAULT_TEMP_WARN = 65`, `DEFAULT_TEMP_DANGER = 75` (단위 °C) — 이벤트 감지·markLine·calibration 기본값의 단일 진실원 상수.
- `computeStreamWindow(frames, currentTime, isActive, streaming, audioDuration, windowSize, pick): StreamWindowResult` — 표시 윈도우 계산. streaming+파일(audioDuration 있음)은 전체 누적, streaming+마이크(audioDuration 없음)는 최근 `windowSize`개, 비streaming(seek)은 `currentTime` 위치까지 최대 `windowSize`개. `current`는 헤더 표시용 `[ch0, ch1]` 현재값.
- `computeExcursionYRange(windowFrames, channelMode, toDisplayUnit, scalePadding): { yMin, yMax }` — 표시 채널의 메인값 + envelope까지 포함한 범위에 대칭 패딩(`span × (scalePadding − 1)`). 빈 입력이면 ±0.01. `toDisplayUnit` 적용 후 값 기준.
- `computeTemperatureYRange(windowFrames, channelMode): { yMin, yMax }` — 기본 0~100 °C 고정, 데이터가 벗어나면 8% 헤드룸 후 10/25/50/100 단위로 올림/내림 확장.
- `buildDataZoom(zoom: ZoomState, colors)` / `buildValueTooltip({ unit, decimals })` — ECharts 옵션 조각 빌더. 시간축(`buildTimeAxis`, 윈도우 첫/마지막 프레임 시각을 따라 스크롤)과 범례(`buildLegend`, `"Both"`일 때만 표시)는 `buildBaseChartOption`이 내부에서 조립하므로 더는 개별 export가 아니다.
- `buildLineSeries({ name, data, color, smooth, width, sampling, area?, markLine?, showSymbol?, symbolSize? })` / `buildValueYAxis({ name, min, max, labelFormatter? })` / `buildAreaGradient(topColor, bottomColor)` / `buildBaseChartOption({ channelMode, windowFrames, zoomRef, gridLeft, zoomColors, timeDecimals, yAxis, series, tooltip })` — Temperature/Excursion이 복붙하던 series·값 축·그라디언트·옵션 골격 빌더. `area`는 없으면 `undefined`(그라디언트 없음), `markLine`은 넘긴 series에만 붙는다. `showSymbol=true`(충분히 확대된 상태)이면 프레임마다 원형 점을 그리는데, 이때 large/LTTB 샘플링은 심볼을 무시하고 솎아내므로 함께 끈다(`symbolSize` 기본 4).
- `shouldShowFrameSymbols(pointCount: number, zoom: ZoomState): boolean` — 현재 줌에서 화면에 보이는 포인트 수(`pointCount × (zoom.end − zoom.start) / 100`)가 `SYMBOL_VISIBLE_MAX`(80) 이하일 때만 true. 각 차트가 dataZoom 이벤트에서 호출해 프레임 점 표시를 토글한다.
- `SYMBOL_VISIBLE_MAX = 80` — 프레임 점을 그릴 "보이는 포인트 수" 상한. 이보다 많으면 점이 뭉개지고 드로우 비용도 커진다.
- `WINDOW_SIZE = 1000` (`chart-window.ts`) — 두 차트 공용 표시 윈도우 프레임 수 상수.
- 타입: `QueuedFrame`, `TempThresholds`, `ChannelMode`, `StreamWindowResult`, `ZoomState`.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: 교차참조 정정 — 차트에서 `followWindow` prop이 제거됨에 따라 `buildTimeAxis` 시그니처를 `{ audioDuration, followWindow, windowFrames }` → `{ windowFrames }`로, batch 고정축 분기 서술을 삭제(섹션 3·5). `computeStreamWindow`의 "배치 seek" 표현을 "seek"으로 정리. 이 도메인의 순수 함수 자체 로직은 변경 없음
- 2026-07-10: 차트 옵션 빌더 통합 반영 — `chart-option.ts`에 Temperature/Excursion이 복붙하던 series·값 축·그라디언트·옵션 골격 빌더 `buildLineSeries`/`buildValueYAxis`/`buildAreaGradient`/`buildBaseChartOption` 추가, `chart-window.ts`에 두 차트 공용 상수 `WINDOW_SIZE`(1000) 신설. 채널 파형(`components/channel/ChannelWaveformCanvas`)도 이 도메인의 줌·시간축 빌더를 소비한다. 섹션 3·4·5 부분 갱신 (커밋 범위: 4ec86d9..HEAD, 워크트리 포함)
- 2026-07-13: 프레임 심볼 인터페이스 반영 — `chart-option.ts`에 `shouldShowFrameSymbols()`/`SYMBOL_VISIBLE_MAX`(80) 신규 export, `buildLineSeries`에 `showSymbol`/`symbolSize` 인자 추가(켜지면 large/LTTB 샘플링 대신 프레임별 원형 점). `buildTimeAxis`/`buildLegend`는 `buildBaseChartOption` 내부 전용으로 바뀌어 export 해제(`ChannelWaveformCanvas`의 import도 `buildTimeAxis`→`SYMBOL_VISIBLE_MAX`로 이동). 섹션 3·4·5 부분 갱신 (커밋 범위: 9f08d59..HEAD, 워크트리 포함)
