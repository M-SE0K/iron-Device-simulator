# chart

## 1. 도메인 설명

Temperature/Excursion 실시간 차트와 그 확대(자세히 보기) 뷰를 담당하는 도메인입니다. 확대 뷰는 메인 차트 데이터에 더해 캡처된 오디오 채널과 보호 감쇠 비교까지 하나의 스택으로 보여줍니다. 어느 항목을 켜고 끌지, 어떤 순서로 놓을지는 사용자가 정합니다.

## 2. 프로젝트 전반에서의 역할

두 메인 차트(`TemperatureChart`, `ExcursionChart`)는 `render/`의 `ChartStore`를 직접 구독해 React 리렌더 없이 uPlot에 데이터를 커밋합니다. 두 차트가 공유하는 로직(런타임 readout, uPlot 데이터 소스, 카드 셸)은 이미 `hooks/`와 `MetricChartCard`로 빼놓은 상태라 메트릭별 컴포넌트에는 색상·임계선·축 포맷 같은 고유 설정만 남습니다. `ChartDetailOverlay`는 별도 라우트가 아니라 `DashboardClient`가 소유한 라이브 데이터를 그대로 재사용하는 풀스크린 오버레이입니다. `channel/` 도메인의 `ChannelSelectDrawer`/`ChannelStackView`/`ChannelWaveformCanvas`/`ProtectedComparePanel`을 조합해서 씁니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `TemperatureChart.tsx` | 온도 차트 — WARN/DANGER 임계선, 값에 따라 헤더 색상을 정하는 규칙 등 온도 고유 설정 |
| `ExcursionChart.tsx` | 변위 차트 — mm 단위 변환, 피크 근접 시 경고 색상 등 변위 고유 설정 |
| `MetricChartCard.tsx` | 두 차트가 공유하는 카드 셸 — 헤더(제목/확대 버튼/현재값) + `UPlotChart` 마운트 + empty state |
| `hooks/useMetricChartRuntime.ts` | React 상태로 필요한 최소값(현재값, 축 소수점 자리수, `showChart`)만 100ms 주기로 갱신 |
| `hooks/useMetricChartSource.ts` | `ChartStore`를 uPlot의 `UPlotDataSource`로 변환하는 공유 로직 |
| `ChartDetailOverlay.tsx` | 확대 뷰 — "표시 항목" 드로어에서 메인 차트/채널/보호 감쇠 비교를 체크·해제하면 `ChannelStackView`가 재배치 가능한 스택으로 렌더링 |

## 4. 의존성 및 흐름

- **가져오는 것**: `lib/render/{detect-events, chart-window, chart-store, metric-chart-options, uplot-option, uplot-plugins, wave-store, channel-meta}`, `lib/engine/core`의 `BYTES_PER_SAMPLE`/`INT16_SCALE`, `lib/units`의 `toMm`/`MM_DECIMALS`, `shared/components/UPlotChart`, `shared/hooks/{useOverlayTransition, useCtrlBToggle}`, `shared/components/overlay/FullscreenOverlay`, `shared/lib/yield-to-main`, `player/capture/types`의 `CaptureSnapshot` 등.
- **`channel/`과의 접점**: `ChartDetailOverlay`가 `ChannelSelectDrawer`/`ChannelStackView`/`ChannelWaveformCanvas`(+`ChannelStatsBadge`)/`ProtectedComparePanel`을 그대로 가져와 조합합니다.
- **소비하는 도메인**: `dashboard/`의 `DashboardClient`가 `TemperatureChart`/`ExcursionChart`/`ChartDetailOverlay`를 마운트합니다. `player/` 도메인에서 받은 `getChannelsSnapshot`/`subscribeChannelStream`/`getProtectedBlob`/`sourceFile`은 `ChartDetailOverlay`에 그대로 넘깁니다.

```
DashboardClient → TemperatureChart/ExcursionChart(store=ChartStore)
  useMetricChartRuntime(store) → 100ms throttle 리드아웃
  useMetricChartSource(store, metric, computeYRange, transform?) → UPlotChart source
  → MetricChartCard → UPlotChart(streamFollow=재생 중일 때)

"확대" 클릭 → ChartDetailOverlay(같은 store, 같은 라이브 데이터 재사용)
  "표시 항목" 드로어에서 메인 차트/채널/보호 비교 체크
  → 채널을 새로 선택하면 getChannelsSnapshot()으로 1회 백필 + subscribeChannelStream()으로 실시간 이어붙임
  → ChannelStackView가 선택된 항목만 재배치 가능한 스택으로 렌더링
```

## 5. 주요 인터페이스 / 진입점

- **`TemperatureChart(props)`** / **`ExcursionChart(props)`** — `store: ChartStore`, `isActive`, `streaming?`, `audioDuration?`, `onExpand?`를 공통으로 받습니다. `TemperatureChart`는 여기에 `warnThreshold?`/`dangerThreshold?`를 더 받습니다.
- **`useMetricChartRuntime({ metric, store, isActive, audioDuration? }): { current, timeDecimals, showChart }`** — 헤더 현재값과 축 소수점 자리수처럼 리렌더가 필요한 값만 뽑아줍니다.
- **`useMetricChartSource(store, metric, computeYRange, transform?): UPlotDataSource`** — `ChartStore`에서 직접 읽어 uPlot에 커밋할 데이터 소스를 만듭니다.
- **`ChartDetailOverlay({ metric: "temperature" | "excursion", store, isActive, audioDuration?, warnThreshold?, dangerThreshold?, getChannelsSnapshot?, subscribeChannelStream?, getProtectedBlob?, sourceFile?, onClose })`** — `DetailMetric` 타입도 함께 export합니다. `getChannelsSnapshot`/`getProtectedBlob`을 생략하면 드로어에 각각 채널 항목/보호 비교 항목이 나타나지 않습니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. ECharts에서 uPlot으로 이미 넘어왔고 두 차트의 공유 로직도 `hooks/`(`useMetricChartRuntime`, `useMetricChartSource`)와 `MetricChartCard.tsx`로 빠져나온 상태를 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
