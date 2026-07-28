# chart

## 1. 도메인 설명

스피커 보호 알고리즘이 계산한 분석 프레임(`AnalysisFrame`)을 개발자가 눈으로 확인하는 실시간 차트로 바꾼다. 온도(°C)와 익스커션(콘 변위, mm) 두 지표를 uPlot 라인 차트로 그려, 임계값 초과·현재값·전체 구간 통계를 한 화면에서 읽게 한다.

이 도메인이 내주는 화면 단위는 셋이다. `TemperatureChart`는 WARN/DANGER 임계선과 온도 곡선을, `ExcursionChart`는 raw 값을 mm 단위로 환산한 변위 곡선을 그린다. `ChartDetailOverlay`는 두 차트 중 하나를 전체 화면 오버레이로 확대한다. 단순 확대는 아니다. 메인 지표 차트와 캡처된 오디오 채널, 보호 감쇠 비교 뷰를 "표시 항목" 드로어에서 함께 체크/해제·재배치·리사이즈하는 스택으로 묶는다. 세 컴포넌트 모두 데이터를 소유하지 않는다. `DashboardClient`가 프레임 버퍼를 props로 내려주면, 차트는 표시 윈도우·Y축 범위 계산을 `lib/render/`의 순수 함수에 맡기고 uPlot 옵션과 컬럼(aligned) 데이터만 조립한다.

## 2. 프로젝트 전반에서의 역할

실시간 데이터 흐름(`오디오 → WASM 엔진 → onFrameReceived → setStreamingFrames → 차트`)의 최종 소비자다. `DashboardClient`가 렌더 경로(출력 큐 + `requestAnimationFrame` 스케줄러, `coalesceFrames`)를 거쳐 만든 `chartFrames` 배열을 받아 화면에 그리는 마지막 단계를 담당한다.

- X축은 항상 표시 윈도우(최근 프레임)를 따라간다. 과거의 realtime/batch 이원 모드와 이를 가르던 `followWindow` prop은 제거됐고, `audioDuration`은 X축 범위 계산이 아니라 헤더 표시/차트 노출(showChart) 판단에만 쓴다.
- Calibration의 `tempWarn`/`tempDanger` 값이 `TemperatureChart`의 임계선(`thresholdsPlugin`)과 헤더 현재값 색상(주황 `#F59E0B`/빨강 `#EF4444`)을 결정한다. 기본값은 `lib/render/detect-events.ts`의 `DEFAULT_TEMP_WARN`(65°C)/`DEFAULT_TEMP_DANGER`(75°C)다. 이벤트 감지(`detectEvents`)와 차트가 같은 상수를 함께 쓴다.
- 렌더 지연 계측은 `perfTrack` prop이 켜진 인스턴스만 수행한다. `hooks/useMetricChartRuntime`이 layout effect에서 N11(React 커밋 전파)을 재고, setData 동기 드로우 시간(ms)은 `UPlotChart`의 `onRender` 콜백이 재서 N12와 `perf.recordRender`로 기록한다.
- 줌은 uPlot 관용 방식이다 — 드래그 영역 선택(내장), 휠 줌(`zoomPlugin`), 더블클릭 리셋. 스트리밍 중 새 프레임이 와도 사용자 줌은 풀리지 않는다(`UPlotChart`가 줌 상태를 감지해 x 스케일을 보존하고, y 창만 새 데이터를 따라간다).
- 확대해서 포인트 간격이 충분히 벌어지면 uPlot 내장 points 동작이 각 프레임 위치에 점을 자동으로 찍는다(TemperatureChart size 5, ExcursionChart size 4). 별도 판정 로직은 없다. uPlot 기본 동작 그대로다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `TemperatureChart.tsx` | 스피커 온도 라인 차트. WARN/DANGER 임계선(`thresholdsPlugin`), 임계값 초과 시 헤더 현재값 색상 변경, Y축 동적 범위(기본 0~100°C, 초과 시 확장), 면적 그라디언트(`buildAreaFill`), spline 곡선(`uPlot.paths.spline`). 새 파일을 로드하면 `key={audioDuration ?? "live"}`가 인스턴스를 재마운트해 줌을 초기화한다. |
| `ExcursionChart.tsx` | 콘 변위 라인 차트. raw 값 × 1/1000로 mm 환산(`toMm`), `SCALE_PADDING`(1.15) 대칭 패딩의 Y축 동적 범위, 현재값이 표시 범위 상단 85%를 넘으면 헤더를 빨강으로 표시한다. envelope(`excursionMin`/`excursionMax`)는 Y축 범위 계산에만 쓰고 series로는 그리지 않는다. |
| `ChartDetailOverlay.tsx` | "자세히 보기" 전체 화면 오버레이. 별도 라우트가 아니라 `DashboardClient`의 라이브 데이터를 그대로 재사용해 정적 export에서도 동작한다. 메인 지표 차트 + 캡처 채널 + 보호 감쇠 비교(`ProtectedComparePanel`)를 "표시 항목" 드로어(`ChannelSelectDrawer`)에서 체크/해제·재배치하면 `ChannelStackView`가 스택으로 렌더한다. 채널 파형은 캡처 청크 스트림(`subscribeChannelStream`)을 폴링 없이 구독해 실시간으로 갱신한다. 새로 선택한 채널의 최근 30초와 과거 확대 구간은 `getChannelsBlob()`의 WAV를 `lib/codec/wav-incremental`로 그때그때 디코딩한다. 진입/이탈 전환과 ESC 닫기는 공용 `shared/hooks/useOverlayTransition` + `shared/components/overlay/FullscreenOverlay` 셸에 위임하고, Ctrl/Cmd+B(드로어 토글)만 컴포넌트가 직접 처리한다. `DetailMetric` 타입(`"temperature" \| "excursion"`)을 export한다. |
| `hooks/useMetricChartRuntime.ts` | 두 지표 차트가 함께 쓰는 런타임 훅. `computeStreamWindow`로 표시 윈도우(=누적 프레임 전체)와 현재값을 계산한다. `perfTrack`일 때는 N11(커밋 전파, layout effect) 계측과 `onRender(ms)` 콜백(N12·`perf.recordRender` 기록, 스트리밍 프레임 커밋이 아닌 드로우는 제외)도 함께 제공한다. |

## 4. 의존성 및 흐름

들어오는 방향 (이 도메인을 import하는 곳):

- `components/dashboard/DashboardClient.tsx` — 유일한 외부 소비자. 세 컴포넌트를 모두 import하고 `streamingFrames`(단일 프레임 버퍼), `isActive`, `audioDuration`, `perfTrack`, 온도 임계값을 내려준다. 차트의 `onExpand` 클릭이 `setDetailChart("temperature" | "excursion")` 상태를 세워 `ChartDetailOverlay`를 띄운다.

나가는 방향 (이 도메인이 import하는 곳):

- `features/audio/types.ts` — `AnalysisFrame` (`time`(초), `temperature`(°C, 스칼라), `excursion`(raw, 스칼라), 병합 메타 `excursionMin/Max` 등).
- `lib/render/chart-window.ts` — `computeStreamWindow`(표시 윈도우 + 현재값 계산), `computeTemperatureYRange`, `computeExcursionYRange`.
- `lib/render/uplot-option.ts` — uPlot 옵션 조각 빌더: 축(`buildTimeAxis`/`buildValueAxis`), 컬럼 변환(`toAlignedData`), 면적 그라디언트(`buildAreaFill`), 시간 소수점 헬퍼(`resolveTimeDecimals`).
- `lib/render/uplot-plugins.ts` — `zoomPlugin`(휠 줌 + 더블클릭 리셋 보정), `tooltipPlugin`(다크 툴팁), `thresholdsPlugin`(WARN/DANGER 임계선, TemperatureChart만).
- `shared/components/UPlotChart.tsx` — uPlot 인스턴스 생명주기·리사이즈·줌 보존·렌더 시간 측정을 감싼 공용 래퍼. 두 차트와 채널 파형 뷰가 모두 이 래퍼를 쓴다.
- `components/channel/*` — `ChartDetailOverlay`가 조립하는 표시 항목 스택 UI(`ChannelSelectDrawer`/`ChannelStackView`/`ChannelWaveformCanvas`)는 이 도메인이 아니라 별도 `components/channel` 도메인에 있다(`workspace/ChannelViewerOverlay`와 공유하려고 분리했다). 채널 라벨/색은 `lib/render/channel-meta`(`channelLabel`/`channelColor`)에서 온다.
- `lib/codec/wav-incremental.ts` — `ChartDetailOverlay` 채널 뷰의 온디맨드 디코딩(`peekWavHeader`/`decodeWavRange`/`appendWindowed`): 저장/세션 WAV의 헤더만 엿보거나 과거 확대 구간·라이브 윈도우만 잘라 읽는다.
- `lib/render/detect-events.ts` — `DEFAULT_TEMP_WARN`(65°C)/`DEFAULT_TEMP_DANGER`(75°C) (TemperatureChart만).
- `shared/hooks/useOverlayTransition.ts` / `shared/components/overlay/FullscreenOverlay.tsx` — `ChartDetailOverlay`의 진입/이탈 애니메이션(rAF + 250ms)·ESC 닫기·루트 다이얼로그 셸을 위임한다(`ChannelViewerOverlay`와 공유).
- `shared/lib/utils.ts` — `cn`, `formatTime`.
- 외부 패키지 — `uplot`(차트 엔진, SSR에서 import해도 안전해 dynamic import 불필요), `lucide-react`(아이콘).

내부 처리 흐름 (두 차트 공통):

```
frames(props) → useMetricChartRuntime
  → computeStreamWindow(frames 참조 그대로)
  → { current(헤더 현재값), windowFrames(그릴 프레임) }
  → compute*YRange(윈도우 기준 Y축 min/max)
  → toAlignedData(컬럼 변환) + uPlot options(useMemo, 임계값 변경 시에만 재생성)
  → <UPlotChart options data yRange onRender>  (key={audioDuration ?? "live"})
```

윈도우 규칙(`computeStreamWindow`): 누적 프레임 전체를 자르지 않고 그린다. `frames` 참조를 그대로 돌려주므로 프레임이 실제로 늘었을 때만 `data` useMemo가 다시 돌고, 그때만 uPlot `setData` 커밋이 일어난다. 줌 상태는 uPlot 인스턴스의 x 스케일 자체에 있다. `UPlotChart`가 스트리밍 setData 때 사용자 줌을 감지해 보존하고, `audioDuration`이 바뀌면(새 파일 로드) key 재마운트로 초기화된다.

`ChartDetailOverlay`도 같은 두 차트를 그대로 다시 렌더하므로, 오버레이를 띄운 상태에서 재생 중 실시간 갱신이 유지된다.

## 5. 주요 인터페이스 / 진입점

- `TemperatureChart` (default export)
  - `(props: { frames: AnalysisFrame[]; isActive: boolean; audioDuration?: number | null; perfTrack?: boolean; onExpand?: () => void; warnThreshold?: number; dangerThreshold?: number }) => JSX`
  - 온도 차트 카드 한 장을 그린다. `warnThreshold`/`dangerThreshold`는 °C 단위이고, 넘기지 않으면 65°C/75°C를 쓴다.
- `ExcursionChart` (default export)
  - `(props: { frames: AnalysisFrame[]; isActive: boolean; audioDuration?: number | null; perfTrack?: boolean; onExpand?: () => void }) => JSX`
  - 변위 차트 카드 한 장을 그린다. 입력 `excursion`은 raw 값이고 표시 직전에 1/1000을 곱해 mm로 환산한다(축·툴팁·헤더 모두 mm, 소수 3자리).
- `ChartDetailOverlay` (default export)
  - `(props: { metric: DetailMetric; frames: AnalysisFrame[]; isActive: boolean; audioDuration?: number | null; warnThreshold?: number; dangerThreshold?: number; getChannelsBlob?: () => Blob | null; subscribeChannelStream?: (fn: CaptureStreamListener) => () => void; getProtectedBlob?: () => Blob | null; sourceFile?: File | null; onClose: () => void }) => JSX`
  - 지정 지표의 전체 화면 상세 뷰와 채널·보호 감쇠 스택을 띄운다. `getChannelsBlob`/`subscribeChannelStream`은 활성 플레이어 핸들에서 온다. 핸들이 없으면 드로어에 메인 차트 항목만 남는다. "보호 감쇠 비교" 항목은 `getProtectedBlob`이 있어야 드로어에 뜬다. `onClose`는 이탈 트랜지션이 끝난 뒤에 호출된다.
- `DetailMetric` (type export, `ChartDetailOverlay.tsx`)
  - `"temperature" | "excursion"` — `DashboardClient`의 상세 뷰 선택 상태 타입.

공통 주의사항: 헤더의 확대 버튼은 `onExpand`를 넘겼을 때만 렌더된다. `frames`가 비어 있고 `audioDuration`도 없으면 차트 대신 빈 상태 안내 문구를 보여준다. `perfTrack`은 `DashboardClient`의 메인 차트 두 인스턴스에서만 켠다(상세 오버레이 인스턴스는 끔 — 렌더 계측 중복 방지).

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: 분석 모드 제거 + 디자인 마이그레이션 반영 — 세 컴포넌트에서 `followWindow` prop 삭제(realtime/batch X축 이원 모드 폐기, X축은 항상 표시 윈도우를 따라감), `audioDuration`은 X축 계산에서 빠지고 표시용으로만 사용, 채널(L/R/Both) 토글을 커스텀 버튼 → 공용 `SegmentedControl`로 교체. 섹션 2·3·4·5 부분 갱신 (색상 팔레트 변경은 표기 대상 아님) (커밋 범위: e0add14..HEAD, 워크트리 포함)
- 2026-07-10: 리팩터 반영 — 채널 파형 뷰 부품(`Channel*`)을 `components/channel` 도메인으로 분리(`ChartDetailOverlay`는 그곳을 조립해 쓴다), `chart-option.ts`에 series·값 축·그라디언트·옵션 골격 빌더가 추가되고 두 차트가 이를 소비, `WINDOW_SIZE`를 `chart-window.ts` 단일 상수로. `ChartDetailOverlay`의 진입/이탈 전환은 공용 `shared/components/overlay/FullscreenOverlay` + `hooks/useOverlayTransition`으로 위임. 섹션 4 부분 갱신 (커밋 범위: 537099f..HEAD, 워크트리 포함)
- 2026-07-13: 프레임 심볼 줌 + `ChartDetailOverlay` 채널 스택 반영 — 두 차트가 확대 시 `shouldShowFrameSymbols`로 프레임별 원형 점을 표시(large/LTTB는 그동안 off). `ChartDetailOverlay`는 메인 차트 + 캡처 채널을 "표시 항목" 드로어(`channel/*`)로 함께 다루는 스택이 됐고 채널 파형은 `subscribeChannelStream` 구독 + `lib/codec/wav-incremental` 온디맨드 디코딩으로 갱신한다. `getChannelsBlob`/`subscribeChannelStream` prop이 추가됐다. 진입/이탈 전환은 공용 오버레이 위임 대신 컴포넌트 인라인(rAF+250ms)으로 되돌렸다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: 9f08d59..HEAD, 워크트리 포함)
- 2026-07-20: `ChartDetailOverlay`의 진입/이탈 전환·ESC 닫기를 다시 공용 `shared/hooks/useOverlayTransition` + `shared/components/overlay/FullscreenOverlay` 셸로 리포인트(인라인 rAF/dialog div 구현 제거, Ctrl/Cmd+B만 컴포넌트에 남김). 섹션 3·4 부분 갱신 (커밋 범위: ca71d94..fb8e4fa)
- 2026-07-27: ECharts → uPlot 전체 이관 — 차트 엔진을 `echarts-for-react`에서 공용 `shared/components/UPlotChart` 래퍼(uPlot) 기반으로 교체. `lttb`/`onReactRender`/`onEchartsRender` prop 삭제(렌더 계측은 `perfTrack` + `useMetricChartRuntime.onRender`로 일원화), 하단 슬라이더 대신 드래그/휠/더블클릭 줌, 프레임 점은 uPlot 내장 points 자동 표시로 대체. 지표 값은 스칼라(모노) 기준으로 정정(채널 L/R/Both 토글 서술 삭제 — 5fe5806 회귀 반영). `hooks/useMetricChartRuntime.ts` 행 추가. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: 14941b7..HEAD, 워크트리 포함)
- 2026-07-27(2): 줌 버그 2건 수정 — ① `UPlotChart`의 `isZoomed()`가 데이터 1점뿐일 때(uPlot의 단일점 패딩)를 사용자 줌으로 오판해 스트리밍 시작 직후 x축이 좁은 범위에 고정되던 문제, ② `xRange`(고정 도메인) prop이 있는 차트에서 x축 커스텀 `range()` 콜백이 드래그/휠 줌의 실제 결과까지 고정 도메인으로 되돌려 확대 자체가 항상 무효화되던 문제(`wheelZoomPlugin`을 `zoomPlugin`으로 개칭, `getFullXRange` 옵션 추가 — 더블클릭 리셋도 로드된 데이터 extent가 아니라 고정 도메인으로 보정). TemperatureChart/ExcursionChart는 `xRange`를 안 써서 영향 없음. 섹션 없음(구현 세부, 인터페이스 변화 아님) — 참고용 이력만 추가.
- 2026-07-28: 비스트리밍 창 경로 제거 반영 — 세 컴포넌트에서 `currentTime` prop과 `streaming` prop이 사라졌다. `streaming`은 호출부가 늘 `true`로 넘기던 값이고, `currentTime`은 재생 위치 기준으로 창을 자르던 `computeStreamWindow`의 분기에서만 쓰여 그 분기와 함께 없어졌다. `useMetricChartRuntime`도 두 인자를 더 받지 않으며 `WINDOW_SIZE`/`findFrameIndex` 의존이 끊겼다. 섹션 3·4·5 부분 갱신 (커밋 범위: 3124dd9..HEAD)
