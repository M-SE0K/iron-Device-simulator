# chart

## 1. 도메인 설명

스피커 보호 알고리즘이 계산한 분석 프레임(`AnalysisFrame`)을 개발자가 눈으로 확인할 수 있는 실시간 차트로 바꾼다. 온도(°C)와 익스커션(콘 변위, mm) 두 지표를 ECharts 라인 차트로 그리고 임계값 초과·현재값·전체 구간 통계를 한 화면에서 읽게 한다.

이 도메인은 세 가지 화면 단위를 제공한다. `TemperatureChart`는 WARN/DANGER 임계선(markLine)과 채널별(L/R/Both) 온도 곡선을, `ExcursionChart`는 raw 값을 mm 단위로 환산한 변위 곡선을 그린다. `ChartDetailOverlay`는 두 차트 중 하나를 전체 화면 오버레이로 확대하고 라이브 통계 타일(현재 L/R, 최대/평균/최소)을 붙인다. 세 컴포넌트 모두 데이터를 소유하지 않는다 — `DashboardClient`가 프레임 버퍼를 props로 내려주고 차트는 표시 윈도우·Y축 범위 계산을 `lib/render/`의 순수 함수에 위임한 뒤 ECharts 옵션만 조립한다.

## 2. 프로젝트 전반에서의 역할

실시간 데이터 흐름(`오디오 → WASM 엔진 → onFrameReceived → setStreamingFrames → 차트`)의 최종 소비자다. `DashboardClient`가 렌더 경로(출력 큐 + 16ms 스케줄러, `coalesceFrames`)를 거쳐 만든 `chartFrames` 배열을 받아 화면에 그리는 마지막 단계를 담당한다.

- 두 분석 모드(`realtime`/`batch`)를 `followWindow` prop 하나로 구분한다: `true`(realtime)면 X축이 슬라이딩 윈도우를 따라가고 `false`(batch)면 X축을 `[0, audioDuration]`으로 고정한다.
- Calibration의 `tempWarn`/`tempDanger` 값이 `TemperatureChart`의 markLine과 헤더 현재값 색상(주황 `#F59E0B`/빨강 `#EF4444`)에 반영된다. 기본값은 `lib/render/detect-events.ts`의 `DEFAULT_TEMP_WARN`(65°C)/`DEFAULT_TEMP_DANGER`(75°C)로, 이벤트 감지(`detectEvents`)와 차트가 같은 상수를 공유한다.
- `TemperatureChart`의 `onReactRender`/`onEchartsRender` 콜백은 렌더 지연 측정 텔레메트리(React 커밋 시각·ECharts 캔버스 드로우 완료 시각, `performance.now()` ms 단위)를 `DashboardClient` 쪽 핸들러로 올려보낸다.
- 다량 포인트 드로우 비용은 LTTB(Largest-Triangle-Three-Buckets) 다운샘플링 + ECharts large 모드(`largeThreshold: 2000`)로 제한한다. `lttb` prop은 측정 A/B 비교용 스위치로 기본 on이다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `TemperatureChart.tsx` | 스피커 온도 라인 차트. 채널 모드(L/R/Both) 토글, WARN/DANGER markLine, 임계값 초과 시 헤더 현재값 색상 변경, Y축 동적 범위(기본 0~100°C, 초과 시 확장), 렌더 텔레메트리 콜백(`onReactRender`/`onEchartsRender`), 줌 상태 ref 보존. |
| `ExcursionChart.tsx` | 콘 변위 라인 차트. raw 값 × `MM_SCALE`(1/1000)로 mm 환산, `SCALE_PADDING`(1.15) 대칭 패딩의 Y축 동적 범위, 현재값이 표시 범위 상단 85%를 넘으면 헤더를 빨강으로 표시. envelope(`excursionMin`/`excursionMax`)는 Y축 범위 계산에만 쓰고 series로는 그리지 않는다(ECharts 부하 3배 방지). |
| `ChartDetailOverlay.tsx` | "자세히 보기" 전체 화면 오버레이(`role="dialog"`). 별도 라우트가 아니라 `DashboardClient`의 라이브 데이터를 그대로 재사용해 정적 export/모바일 셸에서도 동작한다. 위의 두 차트 컴포넌트를 그대로 재사용하고 전체 구간 통계 타일(현재 L/R·최대·평균·최소, 두 채널 결합)을 붙인다. ESC 키로 닫히고 진입/이탈에 250ms 트랜지션을 쓴다. `DetailMetric` 타입(`"temperature" \| "excursion"`)을 export한다. |

## 4. 의존성 및 흐름

들어오는 방향 (이 도메인을 import하는 곳):

- `components/dashboard/DashboardClient.tsx` — 유일한 외부 소비자. 세 컴포넌트를 모두 import하고 `chartFrames`(현재 모드의 프레임 버퍼), `currentTime`, `isActive`, `audioDuration`, `followWindow={analysisMode === "realtime"}`, `lttb`, 온도 임계값을 내려준다. 차트의 `onExpand` 클릭이 `setDetailChart("temperature" | "excursion")` 상태를 세워 `ChartDetailOverlay`를 띄운다.

나가는 방향 (이 도메인이 import하는 곳):

- `features/audio/types.ts` — `AnalysisFrame` (`time`(초), `temperature: [ch0, ch1]`(°C), `excursion: [ch0, ch1]`(raw), 병합 메타 `excursionMin/Max` 등).
- `lib/render/chart-window.ts` — `computeStreamWindow`(표시 윈도우 + 현재값 계산), `computeTemperatureYRange`, `computeExcursionYRange`, `ChannelMode` 타입.
- `lib/render/chart-option.ts` — 공유 ECharts 옵션 조각 빌더 `buildDataZoom`/`buildTimeAxis`/`buildValueTooltip`/`buildLegend`. series·Y축·grid는 각 차트가 직접 구성한다.
- `lib/render/detect-events.ts` — `DEFAULT_TEMP_WARN`(65°C)/`DEFAULT_TEMP_DANGER`(75°C) (TemperatureChart만).
- `shared/lib/utils.ts` — `cn`, `findFrameIndex`, `formatTime`.
- 외부 패키지 — `echarts-for-react`(`next/dynamic`, `ssr: false`로 지연 로드), `lucide-react`(아이콘).

내부 처리 흐름 (두 차트 공통):

```
frames(props) → computeStreamWindow(WINDOW_SIZE=1000)
  → { current(헤더 현재값), windowFrames(그릴 프레임) }
  → compute*YRange(윈도우 기준 Y축 min/max)
  → useMemo로 ECharts option 조립 (series + chart-option 빌더 조각)
  → <ReactECharts option>  (key={channelMode} — 채널 토글 시 재마운트)
```

윈도우 규칙(`computeStreamWindow`): streaming + `audioDuration` 있음(파일)이면 전체 누적 프레임, streaming + 없음(마이크)이면 최근 1000프레임, 비streaming(배치 seek)이면 `currentTime` 위치까지 최대 1000프레임이다. 줌 상태는 `zoomRef`(start/end %)에 저장해 리렌더 없이 option에 반영하고 `audioDuration`이 바뀌면(새 파일 로드) 0~100%로 초기화한다.

`ChartDetailOverlay`는 내부적으로 `TemperatureChart`/`ExcursionChart`를 `streaming` 고정으로 다시 렌더하므로, 오버레이를 띄운 상태에서도 재생 중 실시간 갱신이 유지된다.

## 5. 주요 인터페이스 / 진입점

- `TemperatureChart` (default export)
  - `(props: { frames: AnalysisFrame[]; currentTime: number; isActive: boolean; streaming?: boolean; audioDuration?: number | null; followWindow?: boolean; lttb?: boolean; onReactRender?: (ts: number) => void; onEchartsRender?: (ts: number) => void; onExpand?: () => void; warnThreshold?: number; dangerThreshold?: number }) => JSX`
  - 온도 차트 카드 한 장을 그린다. `warnThreshold`/`dangerThreshold`는 °C 단위이며 미지정 시 65°C/75°C를 쓴다.
  - 주의: `onReactRender`/`onEchartsRender`는 `streaming`이고 프레임 수가 변한 렌더에서만 호출된다(`performance.now()` ms 타임스탬프).
- `ExcursionChart` (default export)
  - `(props: { frames: AnalysisFrame[]; currentTime: number; isActive: boolean; streaming?: boolean; audioDuration?: number | null; followWindow?: boolean; lttb?: boolean; onExpand?: () => void }) => JSX`
  - 변위 차트 카드 한 장을 그린다. 입력 `excursion`은 raw 값이고 표시 직전에 1/1000을 곱해 mm로 환산한다(축·툴팁·헤더 모두 mm, 소수 3자리).
- `ChartDetailOverlay` (default export)
  - `(props: { metric: DetailMetric; frames: AnalysisFrame[]; currentTime: number; isActive: boolean; audioDuration?: number | null; followWindow?: boolean; lttb?: boolean; warnThreshold?: number; dangerThreshold?: number; onClose: () => void }) => JSX`
  - 지정 지표의 전체 화면 상세 뷰를 띄운다. `onClose`는 이탈 트랜지션 250ms 뒤에 호출된다.
- `DetailMetric` (type export, `ChartDetailOverlay.tsx`)
  - `"temperature" | "excursion"` — `DashboardClient`의 상세 뷰 선택 상태 타입.

공통 주의사항: `onExpand`를 넘긴 경우에만 헤더에 확대 버튼이 렌더된다. `frames`가 비어 있고 `audioDuration`도 없으면 차트 대신 빈 상태 안내 문구를 보여준다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
