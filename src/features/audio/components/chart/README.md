# chart

## 1. 도메인 설명

Temperature/Excursion 실시간 차트 두 장을 담당하는 도메인입니다. 세션 전체 데이터를 uPlot에 통째로 넘기는 대신, 보이는 x구간과 픽셀 폭만큼만 `ChartStore.readRange()`로 읽어 커밋하므로 세션 길이와 무관하게 그리기 비용이 일정합니다. 휠 X줌·Y줌, 100ms 주기의 헤더 현재값 리드아웃, 차트 위에 두 점을 이어 표시하는 주석(그리기) 모드까지 여기서 조립합니다.

## 2. 프로젝트 전반에서의 역할

두 메인 차트(`TemperatureChart`, `ExcursionChart`)는 `render/`의 `ChartStore`를 직접 구독해 React 리렌더 없이 uPlot에 데이터를 커밋합니다. 두 차트가 공유하는 로직(리드아웃, view 기반 데이터 소스, 줌 리셋 범위, 주석 모드, 카드 셸)은 `hooks/`와 `MetricChartCard`/`ChartDrawControls`로 빠져 있어 메트릭별 컴포넌트에는 색상·임계선·단위 변환 같은 고유 설정만 남습니다. 예전의 풀스크린 확대 뷰(`ChartDetailOverlay`)는 이 도메인에서 사라졌습니다 — 지금은 `dashboard/`의 `DashboardViewGrid`가 이 차트들을 다른 뷰 카드와 함께 그리드로 배치하고 표시 항목 선택도 `dashboard/`의 `ViewDrawer`가 맡습니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `TemperatureChart.tsx` | 온도 차트 — WARN/DANGER 임계선 플러그인, 임계값에 따른 헤더 색상 규칙 등 온도 고유 설정 |
| `ExcursionChart.tsx` | 변위 차트 — mm 단위 변환(`toMm`), 표시 범위 피크의 85% 초과 시 경고 색상 등 변위 고유 설정 |
| `MetricChartCard.tsx` | 두 차트가 공유하는 카드 셸 — 헤더(제목/그리기 버튼/현재값) + `UPlotChart` 마운트(`yZoom` 활성) + empty state |
| `ChartDrawControls.tsx` | 헤더의 연필/지우개 버튼 — `DrawControl`을 받아 주석 모드 토글과 전체 삭제를 노출 |
| `hooks/useThrottledStoreSnapshot.ts` | 스토어 스냅샷을 100ms 스로틀 + version 비교로 React 상태에 반영하는 공용 훅 |
| `hooks/useMetricChartRuntime.ts` | 헤더 현재값과 차트 표시 여부만 뽑는 리드아웃 (`useThrottledStoreSnapshot` 기반) |
| `hooks/useMetricChartSource.ts` | `ChartStore.readRange()`를 `UPlotChart`의 view 기반 `UPlotDataSource`로 변환 |
| `hooks/useChartFullXRange.ts` | 스냅샷의 `firstX`/`lastX`로 줌 리셋용 전체 x범위 콜백 생성 |
| `hooks/useDrawMode.ts` | 주석(두 점 잇기) 모드 상태 — `canAnnotate`가 꺼지면 모드와 드래프트를 자동 해제 |

## 4. 의존성 및 흐름

- **가져오는 것**: `lib/render`의 `chart-store`/`chart-window`/`annotation-store`/`read-buffer`/`metric-chart-options`/`uplot-plugins`(annotate·thresholds)/`detect-events` 기본 임계 상수, `lib/units`의 `toMm`/`MM_DECIMALS`, `shared/components/UPlotChart`(`UPlotDataSource`/`UPlotOptions`), `shared/lib/utils`의 `cn`, `lucide-react`.
- **소비하는 도메인**: `dashboard/`의 `DashboardViewGrid`가 `TemperatureChart`/`ExcursionChart`를 마운트하고 뷰(카드)별 `AnnotationStore`와 `canAnnotateMetric`을 내려줍니다. Y축 줌·스트림 팔로우는 `UPlotChart`(`yZoom`/`streamFollow`)가 처리하므로 이 도메인은 옵션만 켭니다.

```
DashboardViewGrid → TemperatureChart/ExcursionChart(store=ChartStore, annotations, canAnnotate)
  useMetricChartRuntime(store) → useThrottledStoreSnapshot(100ms, version 비교) → 헤더 현재값
  useMetricChartSource(store, metric, computeYRange, transform?)
    → UPlotChart가 view(xMin/xMax/pxWidth)를 넘겨 read → store.readRange(픽셀당 2점) 커밋
  useChartFullXRange(store) → zoomPlugin 더블클릭 리셋 범위
  useDrawMode(annotations, canAnnotate) → ChartDrawControls(연필/지우개) + annotatePlugin
  → MetricChartCard → UPlotChart(streamFollow=재생 중일 때, yZoom)
```

## 5. 주요 인터페이스 / 진입점

- **`TemperatureChart(props)`** / **`ExcursionChart(props)`** — `store: ChartStore`, `isActive`, `streaming?`, `audioDuration?`, `annotations?: AnnotationStore`, `canAnnotate?`를 공통으로 받습니다. `TemperatureChart`는 여기에 `warnThreshold?`/`dangerThreshold?`(기본 65/75)를 더 받습니다. 툴팁 값은 데이터 컬럼이 아니라 `store.valueAt()`을 읽는 가상 시리즈로 해석합니다.
- **`useThrottledStoreSnapshot(store, selector, isEqual, intervalMs): [selected, setSelected]`** — 알림을 `intervalMs`로 스로틀하고 스냅샷 `version`이 같으면 selector 호출 자체를 건너뜁니다. 리드아웃 주기 상수 `READOUT_INTERVAL_MS`(100ms)도 함께 export합니다.
- **`useMetricChartRuntime({ metric, store, isActive, audioDuration? }): { current, showChart }`** — 헤더 현재값과 차트 표시 여부만 돌려줍니다. `isActive`가 꺼지면 `current`를 null로 되돌립니다.
- **`useMetricChartSource(store, metric, computeYRange, transform?): UPlotDataSource`** — `read(view)`가 `view.xMin`/`xMax`/`pxWidth`로 `store.readRange()`를 호출하고(포인트 예산 = 픽셀 폭×2+2), 줌 판정용 `xFull`을 함께 돌려줍니다.
- **`useChartFullXRange(store): () => [number, number] | null`** — 스냅샷의 `firstX`/`lastX`가 유효할 때만 전체 x범위를 돌려주는 콜백을 만듭니다.
- **`useDrawMode(annotations, canAnnotate): { isEnabled, draw? }`** — `isEnabled`는 `annotatePlugin`에 넘기는 ref 기반 게이트, `draw`(`DrawControl`: `active`/`onToggle`/`onClear`)는 `annotations`와 `canAnnotate`가 모두 있을 때만 존재합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. ECharts에서 uPlot으로 이미 넘어왔고 두 차트의 공유 로직도 `hooks/`(`useMetricChartRuntime`, `useMetricChartSource`)와 `MetricChartCard.tsx`로 빠져나온 상태를 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: 현재 코드로 재동기화 — 풀스크린 확대 뷰(`ChartDetailOverlay`)는 도메인에서 제거되었고 뷰 배치·표시 항목 선택은 `dashboard/`(`DashboardViewGrid`+`ViewDrawer`)로 넘어감. 데이터 소스가 view(x구간+픽셀 폭) 기반 `readRange()`로 전환하고 `hooks/useChartFullXRange.ts` 신설, 두 점 잇기 주석(`useDrawMode`+`ChartDrawControls`+`annotatePlugin`)과 Y축 줌(`UPlotChart yZoom`) 추가, `useMetricChartRuntime`의 `timeDecimals` 반환 중단(축·툴팁이 줌 스팬에서 직접 계산) (커밋 범위: a465514..24d1daa)
