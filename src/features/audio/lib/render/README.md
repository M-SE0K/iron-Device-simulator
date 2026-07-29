# render

## 1. 도메인 설명

엔진이 뿜어내는 분석 프레임(약 100 Hz)을 화면이 감당할 만한 형태로 다듬는 순수 함수 모음이다. 개발자는 이 도메인 하나만 봐도 "프레임 병합 → 이벤트 감지 → 표시 윈도우/축 계산 → uPlot 옵션·플러그인 조립"이라는 렌더 전처리 파이프라인 전체를 파악한다. 채널 파형 표시에 쓰는 부속(엔벨로프·파형 윈도우 타입·채널 메타)도 여기 있다. 원래 `DashboardClient.tsx`와 차트 컴포넌트에 각각 중복 구현돼 있던 로직을 React 상태와 분리해 뽑아낸 코드라서, 모든 함수가 부수효과 없는 순수 함수다(단, `detectEvents`는 인자로 받은 bucket 배열의 요소를 제자리 교체하고, `BucketEnvelope`는 상태를 누적하는 클래스다 — 5절 참고).

## 2. 프로젝트 전반에서의 역할

이 프로젝트는 "입력 PCM 프레임은 절대 버리지 않는다"는 제약(온도 모델이 상태 누적형) 아래에서 모든 최적화를 클라이언트 출력 큐와 렌더 경로에서만 한다. 그 렌더 경로의 계산 파트가 바로 이 도메인이다.

- `DashboardClient.tsx`의 출력 큐 스케줄러(`requestAnimationFrame`)가 실제 화면 표시 기회마다 큐에 쌓인 프레임 bucket을 `detectEvents()` → `coalesceFrames()` 순으로 통과시켜 차트 버퍼(`streamingFrames`)에 넣는다.
- `TemperatureChart.tsx`/`ExcursionChart.tsx`는 그 버퍼를 받아 `chart-window.ts`로 표시 윈도우와 Y축 범위를 계산한 뒤 `uplot-option.ts`의 축·데이터 빌더와 `uplot-plugins.ts`의 플러그인(휠 줌·툴팁·임계선)으로 uPlot 옵션을 조립한다.
- `DEFAULT_TEMP_WARN`(65 °C)/`DEFAULT_TEMP_DANGER`(75 °C)는 이벤트 감지(`detectEvents`), `TemperatureChart`의 markLine, `CalibrationContext`의 기본값이 모두 공유하는 단일 진실원이다.
- X축은 0초를 왼쪽 끝에 고정하고 오른쪽으로만 늘어난다(`computeStreamWindow`가 누적 프레임 배열을 자르지 않고 그대로 반환) — 전체 이력을 버리지 않고 유지하는 `DashboardClient`의 버퍼 정책과 짝을 이룬다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `types.ts` | 출력 큐 단위 타입 `QueuedFrame`(`{ frame: AnalysisFrame; recvAt: number }`) 정의. `coalesce.ts`/`detect-events.ts`의 공용 입력 타입 |
| `coalesce.ts` | bucket에 쌓인 여러 프레임을 요약 프레임 1개로 병합하는 `coalesceFrames()`. 최신 프레임 값을 대표값으로 쓰고 구간 내 `temperatureMax`/`excursionMin`/`excursionMax` envelope와 `sourceCount`/`timeStart`/`timeEnd`를 보존한다 |
| `detect-events.ts` | 온도 임계 교차(WARN/DANGER, 양방향)와 익스커션 피크(앞뒤 프레임보다 절대값이 큰 극값)를 감지하는 `detectEvents()`. 기본 임계값 상수 `DEFAULT_TEMP_WARN`(65)/`DEFAULT_TEMP_DANGER`(75)와 `TempThresholds` 타입의 정의처 |
| `chart-window.ts` | 두 차트 공용의 표시 윈도우 계산 `computeStreamWindow()`와 지표별로 알고리즘이 다른 Y축 동적 범위 계산 `computeExcursionYRange()`(대칭 패딩)/`computeTemperatureYRange()`(0~100 °C 기본, 10/25/50/100 단위 확장). `computeStreamWindow()`는 받은 `frames` 배열을 자르지 않고 참조 그대로 반환한다 — 매 렌더 새 배열을 만들지 않으므로 차트의 `data` useMemo가 프레임이 실제로 늘었을 때만 다시 돈다 |
| `uplot-option.ts` | 두 차트가 공유하는 uPlot 옵션 조각 빌더. 시간축 `buildTimeAxis()`(눈금 소수점을 현재 보이는 스팬에 맞춰 동적 조절, `floorFixed()` 내림 처리로 진행바 `formatTime()`과 초 경계 표시 일치)·값축 `buildValueAxis()`, 컬럼 변환 `toAlignedData()`(windowFrames → `Float64Array` x/y), 면적 그라디언트 `buildAreaFill()`, 시간 소수점 헬퍼 `timeDecimalsForInterval`/`resolveTimeDecimals`, 공용 축·그리드 색 상수의 정의처 |
| `uplot-plugins.ts` | uPlot 플러그인 3종. `zoomPlugin()`(커서 중심 휠 줌, 전체 범위의 99.5% 이상으로 줌 아웃하면 전체 범위 스냅 + `getFullXRange` 옵션이 있으면 더블클릭 리셋도 그 고정 도메인으로 보정), `tooltipPlugin()`(다크 스타일 커서 추적 툴팁), `thresholdsPlugin()`(y=임계값 점선+라벨을 캔버스에 직접 드로잉). 드래그 영역 선택 줌은 uPlot 내장 동작이라 여기 없다 |
| `envelope.ts` | 버킷 단위 min/max 엔벨로프 누적 클래스 `BucketEnvelope`(add/clear/peak). 같은 버킷 격자를 공유하는 엔벨로프들은 `envelopesToAligned()`가 공유 x축 uPlot aligned 데이터로 만든다(버킷당 2점: min이 t, max가 t+dt/2, 미충전 버킷은 null). `ProtectedComparePanel` 전용 |
| `waveform.ts` | 채널 버퍼의 peak/RMS 계산 `channelStats()` |
| `channel-meta.ts` | 채널 라벨/색 단일 소스 `channelLabel()`(ch0=V/ch1=I/ch2+=확장)·`channelColor()` |

## 4. 의존성 및 흐름

**이 도메인이 import하는 것 (들어오는 의존)**

- `@/features/audio/types` → `AnalysisFrame` 타입 (`types.ts`, `coalesce.ts`, `chart-window.ts`, `uplot-option.ts`)
- `uplot` → 타입 전용(`uPlot.Axis`/`uPlot.Plugin`/`uPlot.AlignedData` 등, `uplot-option.ts`/`uplot-plugins.ts`)
- 내부: `coalesce.ts`/`detect-events.ts` → `types.ts`(`QueuedFrame`)

**이 도메인을 import하는 곳 (나가는 의존)**

- `components/dashboard/DashboardClient.tsx` → `coalesceFrames`, `detectEvents`, `DEFAULT_TEMP_WARN`/`DEFAULT_TEMP_DANGER`, `TempThresholds`, `QueuedFrame`
- `components/chart/TemperatureChart.tsx` → `chart-window.ts`(`computeStreamWindow`/`computeTemperatureYRange`), `uplot-option.ts`(`buildTimeAxis`/`buildValueAxis`/`toAlignedData`/`buildAreaFill`/`resolveTimeDecimals`), `uplot-plugins.ts` 3종, `DEFAULT_TEMP_WARN`/`DEFAULT_TEMP_DANGER`(임계선)
- `components/chart/ExcursionChart.tsx` → 위와 동일 구성에서 `thresholdsPlugin` 제외
- `components/channel/ChannelWaveformCanvas.tsx` → `uplot-option.ts`(`buildTimeAxis`/`buildValueAxis`/`timeDecimalsForInterval`), `uplot-plugins.ts`(`zoomPlugin`(`getFullXRange` 전달)/`tooltipPlugin`)
- `components/channel/ProtectedComparePanel.tsx` → `uplot-option.ts`/`uplot-plugins.ts`(`zoomPlugin`에 `getFullXRange` 전달) + `envelope.ts`(`BucketEnvelope`/`envelopesToAligned`)
- `components/chart/ChartDetailOverlay.tsx` → `channel-meta.ts`(`channelLabel`/`channelColor`), `waveform.ts`(`channelStats`)
- `components/calibration/CalibrationContext.tsx` → `DEFAULT_TEMP_WARN`/`DEFAULT_TEMP_DANGER`(calibration 기본값)

**내부 처리 흐름 (실시간 경로, `useQueue=true` 기준)**

```
엔진 frame 수신 → outputQueue(QueuedFrame[]) 적재
  → requestAnimationFrame 스케줄러가 표시 프레임마다 bucket 추출
  → detectEvents(bucket, prevTemp, thresholds)   # isEvent/eventType 마킹 (제자리 교체)
  → coalesceFrames(bucket)                       # 요약 프레임 1개 + envelope
  → setStreamingFrames → Temperature/ExcursionChart
      → computeStreamWindow() → windowFrames
      → computeTemperatureYRange() / computeExcursionYRange()
      → toAlignedData() + buildTimeAxis/buildValueAxis + 플러그인 → UPlotChart(options, data)
```

`detectEvents`가 `coalesceFrames`보다 먼저 실행되어야 한다 — 이벤트 마킹이 병합 결과에 반영되는 구조다.

## 5. 주요 인터페이스 / 진입점

- `coalesceFrames(bucket: QueuedFrame[]): AnalysisFrame` — bucket을 요약 프레임 1개로 병합. 길이 1이면 그대로 반환. 온도는 최신값 + 구간 최댓값(`temperatureMax`), 익스커션은 최신값 + min/max envelope(`excursionMin`/`excursionMax`)를 채운다. 주의: `detectEvents` 이후에 호출해야 이벤트 마킹이 반영된다.
- `detectEvents(bucket: QueuedFrame[], prevTemp: [number, number] | null, thresholds?: TempThresholds): QueuedFrame[]` — 온도 임계 교차(WARN/DANGER 각각 아래→위, 위→아래 양방향)와 익스커션 피크를 감지해 해당 `bucket[i].frame`을 `isEvent: true, eventType: "temp_warn" | "temp_danger" | "exc_peak"`가 채워진 새 객체로 제자리 교체하고 감지된 `QueuedFrame` 배열을 반환한다. `prevTemp`는 직전 렌더 사이클 마지막 온도(bucket 경계 교차 감지용). `thresholds` 생략 시 65/75 °C.
- `DEFAULT_TEMP_WARN = 65`, `DEFAULT_TEMP_DANGER = 75` (단위 °C) — 이벤트 감지·markLine·calibration 기본값의 단일 진실원 상수.
- `computeStreamWindow(frames, isActive, pick): StreamWindowResult` — 표시 윈도우 계산. `frames`를 자르지 않고 참조 그대로 `windowFrames`에 실어 반환한다(0초 원점 고정). `current`는 헤더 표시용 스칼라 현재값으로 마지막 프레임에서 뽑으며, `isActive`가 false거나 `frames`가 비면 null이다. `pick`이 프레임에서 지표를 고른다.
- `computeExcursionYRange(windowFrames, toDisplayUnit, scalePadding): { yMin, yMax }` — 메인값 + envelope까지 포함한 범위에 대칭 패딩(`span × (scalePadding − 1)`). 빈 입력이면 ±0.01. `toDisplayUnit` 적용 후 값 기준.
- `computeTemperatureYRange(windowFrames): { yMin, yMax }` — 기본 0~100 °C 고정, 데이터가 벗어나면 8% 헤드룸 후 10/25/50/100 단위로 올림/내림 확장.
- `buildTimeAxis(dataDecimals): uPlot.Axis` — 시간축. 눈금 소수점을 현재 x 스케일 스팬(≥10초 → 0자리, ≥1초 → 1자리, ≥0.1초 → 2자리, 그 미만 → 3자리)과 `dataDecimals` 중 작은 쪽으로 정하고 내림(`floorFixed`) 표기한다.
- `buildValueAxis({ size, formatter? }): uPlot.Axis` — 값축. `size`는 축 영역 px 폭, `formatter`는 눈금 문자열 변환.
- `toAlignedData(frames, pick): uPlot.AlignedData` — windowFrames를 `[Float64Array x(time), Float64Array y(pick 결과)]` 컬럼으로 변환.
- `buildAreaFill(topColor, bottomColor): uPlot.Series.Fill` — 플롯 영역 세로 그라디언트 fill 함수.
- `timeDecimalsForInterval(intervalSec)` / `resolveTimeDecimals(windowFrames)` — 데이터 간격 기반 시간 소수점(0~3자리) 계산.
- `zoomPlugin(opts?: { getFullXRange?: () => [number, number] | null }): uPlot.Plugin` — 커서 위치 중심 휠 줌(배율 0.75). 전체 범위의 99.5% 이상으로 줌 아웃하면 전체 범위로 스냅해 줌 해제 상태로 복귀한다. `getFullXRange`가 있으면(고정 도메인 차트) 그 값을 "전체 범위"로 쓰고, uPlot 기본 더블클릭 리셋(로드된 데이터 extent 기준)도 같은 도메인으로 즉시 보정한다 — `getFullXRange`가 자주 바뀌는 값(세션 길이 등)을 감싼다면 반드시 참조가 안정된 함수로 넘겨야 한다(그 값이 uPlot 옵션 객체에 박히므로, 참조가 매번 바뀌면 인스턴스가 매번 재생성된다).
- `tooltipPlugin({ unit, decimals, timeDecimals? }): uPlot.Plugin` — 커서 추적 다크 툴팁. 표시 중인 시리즈만 나열하고 플롯 우측 경계에서 좌측으로 뒤집힌다.
- `thresholdsPlugin(lines: { y, color, label }[]): uPlot.Plugin` — y=임계값 점선+라벨을 캔버스에 직접 그린다. 현재 y 스케일 밖의 임계값은 건너뛴다.
- `BucketEnvelope(buckets)` — 버킷 단위 min/max 누적 클래스. `add(bucket, v)`/`clear()`/`peak()`. 상태를 누적하므로 세션 리셋 시 `clear()`가 필요하다.
- `envelopesToAligned(envs, durationSec)` — 같은 버킷 수/길이의 엔벨로프들을 공유 x축 aligned 데이터로 변환(버킷당 2점, 미충전 버킷 null).
- `channelStats(data: Float32Array): { peak, rms }` — 채널 버퍼 통계.
- `channelLabel(ch)` / `channelColor(ch)` — 채널 의미(ch0=V/ch1=I/ch2+=확장)·색의 단일 소스.
- 타입: `QueuedFrame`, `TempThresholds`, `StreamWindowResult`.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: 교차참조 정정 — 차트에서 `followWindow` prop이 제거됨에 따라 `buildTimeAxis` 시그니처를 `{ audioDuration, followWindow, windowFrames }` → `{ windowFrames }`로, batch 고정축 분기 서술을 삭제(섹션 3·5). `computeStreamWindow`의 "배치 seek" 표현을 "seek"으로 정리. 이 도메인의 순수 함수 자체 로직은 변경 없음
- 2026-07-10: 차트 옵션 빌더 통합 반영 — `chart-option.ts`에 Temperature/Excursion이 복붙하던 series·값 축·그라디언트·옵션 골격 빌더 `buildLineSeries`/`buildValueYAxis`/`buildAreaGradient`/`buildBaseChartOption` 추가, `chart-window.ts`에 두 차트 공용 상수 `WINDOW_SIZE`(1000) 신설. 채널 파형(`components/channel/ChannelWaveformCanvas`)도 이 도메인의 줌·시간축 빌더를 소비한다. 섹션 3·4·5 부분 갱신 (커밋 범위: 4ec86d9..HEAD, 워크트리 포함)
- 2026-07-13: 프레임 심볼 인터페이스 반영 — `chart-option.ts`에 `shouldShowFrameSymbols()`/`SYMBOL_VISIBLE_MAX`(80) 신규 export, `buildLineSeries`에 `showSymbol`/`symbolSize` 인자 추가(켜지면 large/LTTB 샘플링 대신 프레임별 원형 점). `buildTimeAxis`/`buildLegend`는 `buildBaseChartOption` 내부 전용으로 바뀌어 export 해제(`ChannelWaveformCanvas`의 import도 `buildTimeAxis`→`SYMBOL_VISIBLE_MAX`로 이동). 섹션 3·4·5 부분 갱신 (커밋 범위: 9f08d59..HEAD, 워크트리 포함)
- 2026-07-20: X축 0초 원점 고정 반영 — `computeStreamWindow`가 streaming일 때 파일/마이크 구분 없이 항상 전체 누적 프레임을 반환하도록 변경(과거엔 마이크만 최근 `windowSize`개로 잘랐음). `chart-option.ts`의 `dataMin`도 항상 0으로 고정. `buildDynamicTimeFormatter`가 내부 `floorFixed()`로 반올림 대신 내림 처리하도록 바뀌어 진행바(`formatTime`, `Math.floor` 기반)와 초 경계 표시가 어긋나던 문제를 없앴다. 섹션 2·3·5 부분 갱신 (커밋 범위: 14af466..fb8e4fa, 워크트리 포함 — `chart-option.ts`의 floorFixed 변경은 아직 커밋되지 않음)
- 2026-07-27: ECharts → uPlot 이관 반영 — `chart-option.ts` 삭제, `uplot-option.ts`(축·컬럼 변환·그라디언트)와 `uplot-plugins.ts`(휠 줌·툴팁·임계선) 신설. `shouldShowFrameSymbols`/`SYMBOL_VISIBLE_MAX`/`ZoomState`는 uPlot 내장 points·스케일로 대체돼 삭제. 이전 미반영분도 함께 정리: `envelope.ts`(+신규 `envelopesToAligned`)·`waveform.ts`·`channel-meta.ts` 행 추가, `computeStreamWindow`/`compute*YRange` 시그니처를 스칼라(모노) 기준으로 정정. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: f9ad37e..HEAD, 워크트리 포함)
- 2026-07-27(2): `wheelZoomPlugin` → `zoomPlugin` 개칭 + `getFullXRange` 옵션 추가 반영 — `xRange`(고정 도메인) prop이 있는 차트에서 드래그/휠 줌이 항상 고정 도메인으로 되돌아가버리던 버그를 고치며 `shared/components/UPlotChart.tsx`의 x축 커스텀 `range()` 콜백을 제거했고, 그 콜백이 하던 "고정 도메인 우선" 역할 중 더블클릭 리셋 보정 부분을 `zoomPlugin`의 `getFullXRange`로 옮겼다. 섹션 3·5 부분 갱신 (워크트리, 미커밋)
- 2026-07-28: 비스트리밍 창 경로 제거 반영 — `computeStreamWindow`에서 `currentTime` 기준으로 과거 `windowSize`개만 잘라 보던 분기를 삭제해 시그니처가 `(frames, isActive, pick)`로 줄었고, 그 분기 전용이던 `WINDOW_SIZE`(1000) 상수와 `@/shared/lib/utils`의 `findFrameIndex()` 의존이 함께 사라졌다. 삭제된 분기는 `streaming` prop이 항상 `true`라 실행된 적이 없는 죽은 코드였다 — 런타임 동작은 그대로이고 표면적만 줄었다. 섹션 2·3·4·5 부분 갱신 (커밋 범위: 3124dd9..HEAD)
