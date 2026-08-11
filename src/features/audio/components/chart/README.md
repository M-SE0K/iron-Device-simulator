# chart

## 1. 도메인 설명

Temperature/Excursion 실시간 차트를 담당하는 도메인입니다. 두 차트는 카드 셸, 스토어 리드아웃, uPlot 데이터 소스, 점 잇기 주석 컨트롤을 함께 씁니다. 메트릭별 컴포넌트에는 색상·임계선·단위 변환 같은 고유 설정만 남습니다. 그 공유 부품 일부(`useThrottledStoreSnapshot`·`useDrawMode`·`ChartDrawControls`)는 채널 파형 카드도 그대로 가져다 씁니다.

## 2. 프로젝트 전반에서의 역할

두 메인 차트(`TemperatureChart`, `ExcursionChart`)는 `render/`의 `ChartStore`를 직접 구독해 React 리렌더 없이 uPlot에 데이터를 커밋합니다. 리렌더가 필요한 값은 헤더 현재값 정도인데, 그마저 100 ms 주기로 스로틀해 읽습니다.

읽기 전략이 채널 파형과 다릅니다. 파형은 세션 전체 엔벨로프를 통째로 읽지만 메트릭 차트는 **지금 보이는 x 구간만 화면 폭만큼의 점으로** 읽습니다(`store.readRange`). 그 대가로 "전체 도메인"을 별도로 알려줘야 합니다 — `u.data`의 extent가 곧 확대해 놓은 창이 돼 버리기 때문입니다. 줌 판정과 줌아웃 복원의 기준은 `xFull`(데이터 소스)과 `getFullXRange`(줌 플러그인) 양쪽에 같은 값으로 넘깁니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `TemperatureChart.tsx` | 온도 차트 — WARN/DANGER 임계선, 값에 따라 헤더 색상을 정하는 규칙 등 온도 고유 설정 |
| `ExcursionChart.tsx` | 변위 차트 — mm 단위 변환, 피크 근접 시 경고 색상 등 변위 고유 설정 |
| `MetricChartCard.tsx` | 두 차트가 공유하는 카드 셸 — 헤더(제목/현재값/그리기 컨트롤) + `UPlotChart` 마운트 + empty state |
| `ChartDrawControls.tsx` | 카드 헤더의 연필(그리기 모드)·지우개(전체 지우기) 버튼. `draw`가 없으면 아무것도 그리지 않는다 |
| `hooks/useMetricChartRuntime.ts` | React 상태로 필요한 최소값(헤더 현재값, `showChart`)만 스로틀해 갱신 |
| `hooks/useMetricChartSource.ts` | `ChartStore`를 uPlot의 `UPlotDataSource`로 변환하는 공유 로직 — 보이는 구간만 재사용 버퍼에 채워 커밋 |
| `hooks/useChartFullXRange.ts` | 세션 전체 x 도메인 getter — `zoomPlugin`에 넘긴다 |
| `hooks/useDrawMode.ts` | 점 잇기 그리기 모드의 카드 단위 상태 + `DrawControl` 타입 |
| `hooks/useThrottledStoreSnapshot.ts` | 버전 있는 스토어 스냅샷을 일정 주기로만 React 상태에 반영하는 범용 훅 |

## 4. 의존성 및 흐름

- **가져오는 것**: `lib/render/{detect-events, chart-window, chart-store, metric-chart-options, read-buffer, uplot-plugins, annotation-store}`, `lib/units`의 `toMm`/`MM_DECIMALS`, `shared/components/UPlotChart`, `shared/lib/utils`의 `cn`.
- **소비하는 쪽**: `dashboard/DashboardViewGrid`가 `TemperatureChart`/`ExcursionChart`를 그리드 카드로 마운트합니다. 공유 부품은 도메인 밖으로도 나갑니다 — `dashboard/ChannelChartCard`가 `useDrawMode`와 `ChartDrawControls`를, `channel/ChannelWaveformCanvas`가 `useThrottledStoreSnapshot`을 씁니다. 즉 이 도메인은 메트릭 차트 두 개만 파는 곳이 아니라 "카드형 차트의 공통 규약"까지 함께 맡습니다.
- **참조 안정성 규칙**: `getFullXRange`(줌)와 `isEnabled`(그리기 모드)는 uPlot 옵션 객체에 박히므로 참조가 고정돼야 합니다. `useChartFullXRange`는 store가 같은 한 같은 함수를 돌려줍니다. `useDrawMode`는 상태가 아니라 ref를 읽는 getter를 내줍니다. 매 렌더 새 함수를 넘기면 인스턴스가 통째로 재생성되며 줌 상태를 잃습니다.

```
DashboardViewGrid → TemperatureChart/ExcursionChart(store=ChartStore)
  useMetricChartRuntime(store) → 100 ms 스로틀 리드아웃(헤더 현재값)
  useMetricChartSource(store, metric, computeYRange, transform?) → UPlotChart source
    read(view) → store.readRange(보이는 구간, 화면 폭×2+2점, 재사용 버퍼) + xFull
  useChartFullXRange(store) → zoomPlugin의 getFullXRange (xFull과 같은 값이어야 함)
  useDrawMode(annotations, canAnnotate) → isEnabled(플러그인용) + draw(헤더 버튼용)
  → MetricChartCard → UPlotChart(streamFollow=재생 중일 때)
```

## 5. 주요 인터페이스 / 진입점

- **`TemperatureChart(props)`** / **`ExcursionChart(props)`** — `store: ChartStore`, `isActive`, `streaming?`, `audioDuration?`, `annotations?`, `canAnnotate?`를 공통으로 받습니다. `TemperatureChart`는 여기에 `warnThreshold?`/`dangerThreshold?`(기본값은 `DEFAULT_TEMP_WARN` 65 / `DEFAULT_TEMP_DANGER` 75)를 더 받습니다. `annotations`를 넘기고 `canAnnotate`가 참일 때만 헤더에 연필 토글이 나타납니다.
- **`useMetricChartRuntime({ metric, store, isActive, audioDuration? }): { current, showChart }`** — 헤더 현재값처럼 리렌더가 필요한 값만 뽑아줍니다. `current`는 `isActive`가 아니거나 점이 없으면 `null`이고, `showChart`는 `audioDuration`이 주어졌거나 점이 하나라도 있으면 참입니다.
- **`useMetricChartSource(store, metric, computeYRange, transform?): UPlotDataSource`** — 보이는 구간만 이 차트 소유의 재사용 버퍼에 채워 커밋합니다. 점 예산은 픽셀 열마다 2점 + 양 끝점 2점이고, 인스턴스가 아직 없어 `view` 없이 읽힐 때는 1,024 px을 가정합니다. ⚠️ `computeYRange`/`transform`은 의존성 배열에 넣지 않습니다 — 두 차트가 렌더마다 새 클로저를 넘기지만 그 안에서 참조하는 값이 모듈 상수라 동작이 같고, `read()`는 `UPlotChart`가 ref로 호출하므로 stale 값을 돌려주지 않습니다.
- **`useChartFullXRange(store): () => [number, number] | null`** — 스냅샷의 `firstX`/`lastX`를 그대로 돌려줍니다. 점이 없거나 폭이 0이면 `null`. ⚠️ 이 값은 `useMetricChartSource`가 `xFull`로 내는 값과 **반드시 같아야** 합니다 — 둘이 어긋나면 줌아웃해도 계속 "줌 중"으로 남아 스트리밍 추종이 되살아나지 않습니다.
- **`useDrawMode(annotations, canAnnotate): { isEnabled, draw, drawMode }`** — `isEnabled`는 플러그인에 넘길 안정된 getter, `draw`는 헤더 버튼용 `DrawControl`(`annotations`가 없거나 `canAnnotate`가 거짓이면 `undefined`)입니다. `canAnnotate`가 풀리면(재생 재개) 그리기 모드에서 자동으로 빠져나오고 진행 중이던 드래프트도 취소합니다.
- **`DrawControl`** (type) — `{ active: boolean; onToggle(): void; onClear(): void }`.
- **`ChartDrawControls({ chartLabel, draw? })`** (default export) — 연필/지우개 버튼. 지우개는 그리기 모드일 때만 나타납니다.
- **`useThrottledStoreSnapshot(store, selector, isEqual, intervalMs): [selected, setSelected]`** — `{ snapshot(), subscribe() }`와 `version` 필드를 가진 스토어면 무엇이든 받습니다. 같은 `version`이면 건너뛰고, `isEqual`이 참이면 상태를 갱신하지 않습니다. 기본 주기 상수는 **`DEFAULT_STORE_READOUT_INTERVAL_MS`**(100)입니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. ECharts에서 uPlot으로 이미 넘어왔고 두 차트의 공유 로직도 `hooks/`(`useMetricChartRuntime`, `useMetricChartSource`)와 `MetricChartCard.tsx`로 빠져나온 상태를 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-11: 확대 오버레이 제거와 뷰포트 읽기를 반영했습니다. `ChartDetailOverlay.tsx`가 삭제되어(그 역할은 대시보드 View 그리드가 대신합니다) 이 도메인은 `channel/` 부품을 더 이상 조합하지 않습니다. `MetricChartCard`의 확대 버튼과 `onExpand` prop도 함께 사라졌습니다. 대신 문서에 빠져 있던 `ChartDrawControls.tsx`·`hooks/useDrawMode.ts`·`hooks/useThrottledStoreSnapshot.ts`를 §3·§5에 넣었고 신규 `hooks/useChartFullXRange.ts`와 `useMetricChartSource`의 뷰포트 읽기(`store.readRange` + 재사용 버퍼 + `xFull`)를 서술했습니다. `useMetricChartRuntime`의 반환값에서는 `timeDecimals`가 빠졌습니다(축 소수점은 이제 `uplot-option`이 스케일에서 직접 계산합니다). 두 차트는 `annotations`/`canAnnotate` prop을 받습니다. 이 도메인의 공유 훅을 `channel/`·`dashboard/`가 역방향으로 가져다 쓰는 관계도 §1·§4에 명시했습니다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: a465514..HEAD, 작업 트리 포함)
