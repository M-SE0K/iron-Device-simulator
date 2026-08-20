# shared

## 1. 도메인 설명

여러 도메인이 공통으로 쓰는 UI 프리미티브(드로어/셀렉트 등), 앱 전역 피드백(에러/성공 팝업), 앱을 열 때 한 번 덮이는 시작 로딩 화면, uPlot 차트 공용 래퍼와 그 밑의 렌더 인프라(프레임 스케줄러, DPR 캡, Y축 줌), 그 밖의 자잘한 유틸(문자열·파일·시간 포맷, IPC 에러 메시지 변환)을 모아둔 도메인입니다. `lib/tauri-bridge/`(Tauri IPC shim)와 `lib/iron-perf/`(perf 계측 수집기)는 각각 별도 도메인으로 떼어놨습니다.

## 2. 프로젝트 전반에서의 역할

`features/audio`의 거의 모든 컴포넌트 도메인이 기대는 하부 인프라입니다. `SideDrawer`/`AnimatedSelect`/`CountBadge`/`LabeledField`/`SegmentedControl`은 여러 드로어가 반복해서 복붙하던 마크업을 한곳으로 모았습니다. `ErrorPopupContext`는 화면 곳곳에 흩어져 있던 에러/성공 피드백을 중앙 모달 하나로 통일합니다. 여기에 더해 이 도메인은 차트 렌더의 공용 토대가 됐습니다. `UPlotChart`가 uPlot 인스턴스 관리·뷰포트 기반 데이터 읽기·스트림 추적 스케일을 맡고, `frameScheduler`(rAF 단일 루프)·`dpr-cap`(캔버스 DPR 상한 1.5)·`attachYZoom`(Y축 휠 줌/팬)이 그 밑을 받칩니다. 표시 언어(i18n) 계층과 좌측 `Sidebar`는 이 도메인에서 빠졌습니다 — i18n은 92fbb5a에서 배선을 되돌리며 제거됐고 `Sidebar`는 `features/audio/components/dashboard/Sidebar.tsx`로 이동했습니다. `components/splash/`도 여기에 들어왔습니다. 앱 진입 연출은 대시보드의 관심사가 아니고 `app/layout.tsx`가 Provider 트리 가장 안쪽에서 마운트하는 껍데기라서 `features/audio`가 아니라 이 도메인에 두었습니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `components/overlay/SideDrawer.tsx` | 우측 슬라이드 드로어 공용 셸 |
| `components/error-popup/{ErrorPopupContext.tsx, ErrorPopupModal.tsx, popup-types.ts}` | 앱 전역 에러/성공 피드백 큐 + 중앙 모달 |
| `components/ui/{AnimatedSelect.tsx, CountBadge.tsx, LabeledField.tsx, SegmentedControl.tsx}` | 공용 UI 프리미티브(커스텀 셀렉트, 개수 배지, 라벨+컨트롤 레이아웃, 세그먼트 토글) |
| `components/splash/{SplashGate.tsx, LoadingSplash.tsx}` | 앱 시작 로딩 화면 — `SplashGate`가 `children` 위에 오버레이를 얹고 `LoadingSplash`가 rAF 루프로 로고 채움·캔버스 파티클·클릭 물결을 그린다 |
| `components/UPlotChart.tsx` | uPlot 공용 래퍼 — data(React 상태) 모드와 source(구독 기반) 모드, 뷰포트 기반 `source.read()`, 스트림 추적(`streamFollow`), 시리즈 토글(`seriesShow`), Y축 줌(`yZoom`) 지원 |
| `hooks/useGlobalKey.ts` | 전역 키보드 훅 `useCtrlBToggle`/`useEscapeKey` — 구 3파일(useCtrlBToggle/useEscapeKey/useOverlayTransition)을 1파일로 통합, `useOverlayTransition`은 삭제 |
| `lib/dpr-cap.ts` | import 부수효과로 `window.devicePixelRatio` getter를 1.5 상한으로 덮어쓰는 모듈(차트 캔버스 픽셀 수 절감, 1회 설치 플래그 `__ironChartDprCap`) |
| `lib/element-rect.ts` | `createRectCache(el)` — `getBoundingClientRect()` 결과를 한 애니메이션 프레임 동안 캐시 |
| `lib/frame-scheduler.ts` | `frameScheduler` 싱글턴 — compute/draw 2단계 rAF 루프. dirty한 태스크만 실행하고 draw는 프레임당 최대 4개 라운드로빈 |
| `lib/uplot-y-zoom.ts` | `attachYZoom(u, ctrl)` — Y축 스트립 위 휠 줌(0.85배율)·포인터 드래그 팬·더블클릭 리셋, auto 범위의 99.5% 이상으로 벌어지면 auto로 스냅 |
| `lib/ipc-error.ts` | 네이티브 IPC/헬퍼의 짧은 에러 코드를 사용자용 문장으로 변환 |
| `lib/utils.ts` | `cn`/`formatTime`/`round3`/`formatFileSize`/`splitFileName`/`sanitizeFileName`/`splitPath`/`downloadBlob` |
| `lib/yield-to-main.ts` | 메인 스레드를 짧게 양보하는 `yieldToMain()` |
| `lib/tauri-bridge/` · `lib/iron-perf/` | 각각 별도 도메인 — 해당 폴더의 README 참고 |
| `types/native-bridge.d.ts` | `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`/`wasmAsset` 전역 타입 계약 + 브리지 결과 타입(`AudioCaptureStartResult` 등) export — tauri-bridge shim이 이 타입들을 직접 import |

## 4. 의존성 및 흐름

- **가져오는 것**: `clsx`/`tailwind-merge`(`cn`), `uplot`(`UPlotChart`, `uplot-y-zoom`). `lib/utils.ts`의 `downloadBlob()`은 `tauri-bridge/file-export`의 `saveFileViaTauri()`로, `UPlotChart`는 `iron-perf`의 `recordPerfSample()`로 위임합니다 — 하위 두 도메인을 직접 가져오는 지점은 이 둘입니다.
- **소비하는 도메인**: 사실상 `features/audio` 전역입니다. Calibration/Records/Workspace/ChannelSelect 네 드로어는 모두 `SideDrawer` 위에 얹혀 있습니다. `useCtrlBToggle`/`useEscapeKey`는 드로어·대시보드 5곳이 씁니다. `UPlotChart`는 메트릭 차트(`MetricChartCard`/`useMetricChartSource`)와 채널 파형·보호 비교 차트(`ChannelWaveformCanvas`/`ProtectedComparePanel`)의 공용 캔버스입니다. 렌더 인프라는 이 도메인 밖에서도 직접 쓰입니다 — `lib/render/uplot-plugins/envelope-overlay.ts`가 `frameScheduler`+`dpr-cap`을, `uplot-plugins/zoom.ts`가 `createRectCache`를, `channel/hooks/useChannelWaveStreams.ts`가 `yieldToMain`을 가져갑니다. `app/layout.tsx`는 Provider 트리 가장 안쪽에서 `SplashGate`를 마운트합니다. 이 도메인 안에서 `features/audio`를 거꾸로 가져가는 곳은 없습니다.

```
app/layout.tsx → ErrorPopupProvider 마운트
어디서든 useErrorPopup().showError()/showSuccess() 호출 → 큐 적재 → ErrorPopupModal이 중앙에 표시

UPlotChart(source 모드) — source.subscribe(markDirty) 구독
  → frameScheduler.register({phase:"draw", isDirty, run})
  → rAF 프레임마다 dirty일 때만 source.read({xMin, xMax, pxWidth})로 현재 뷰포트 분량만 읽어 setData
    (줌 상태에서는 좌우로 각각 뷰포트 폭의 50%(SOURCE_OVERREAD)를 더 읽고 pxWidth도 2배로 요청 —
     스케일이 바뀐 뒤 다시 읽기까지의 한 프레임 동안 옛 데이터가 새 범위를 덮게 하기 위함)
  → 커밋 소요를 recordPerfSample("chart_render")로 계측
  → yZoom prop이 켜지면 attachYZoom이 Y축 휠/드래그를 yLock으로 반영

app/layout.tsx → SplashGate가 {children} 위에 LoadingSplash를 겹침
  → durationMs(기본 4500ms) 타이머가 0 → 100%를 채우는 동안 대시보드는 뒤에서 이미 마운트돼 초기화
  → ENTER 클릭(또는 Enter/Space) → 원형 와이프 0.9s → 페이드아웃 0.5s → onFinish로 LoadingSplash 언마운트
```

## 5. 주요 인터페이스 / 진입점

- **`cn(...inputs)`** / **`formatTime(seconds)`** / **`round3(v)`** / **`formatFileSize(bytes)`** / **`splitFileName(name)`** / **`sanitizeFileName(name)`** / **`splitPath(path)`** / **`downloadBlob(blob, filename)`** — `lib/utils.ts`의 범용 유틸.
- **`humanizeIpcError(raw, fallback): string`** — 알려진 IPC 에러 코드·fs errno·이미 사람이 쓴 문장을 구분해 사용자용 메시지로 바꿉니다.
- **`yieldToMain(): Promise<void>`** — `scheduler.yield()`가 있으면 그걸, 없으면 `MessageChannel`로 매크로태스크 양보.
- **`useErrorPopup(): { showError, showSuccess }`** — `ErrorPopupProvider` 트리 안에서만 호출 가능.
- **`useCtrlBToggle(handler)`** / **`useEscapeKey(handler, enabled?)`**(`hooks/useGlobalKey.ts`) — 전역 keydown 공용 훅. Ctrl/Cmd+B는 `preventDefault`까지 수행합니다.
- **`frameScheduler.register(task): () => void`** — `{id, phase: "compute"|"draw", isDirty(), run()}` 태스크를 rAF 루프에 등록하고 해제 함수를 돌려줍니다. draw 태스크는 프레임당 최대 4개만 실행됩니다.
- **`createRectCache(el): { get, dispose }`** — 다음 애니메이션 프레임까지 유효한 `DOMRect` 캐시.
- **`attachYZoom(u: uPlot, ctrl: YZoomController): () => void`** — Y축 줌/팬 부착기. `ctrl.getAuto()`(자동 범위)와 `ctrl.apply(range | null)`(줌 반영/해제)만 구현하면 됩니다.
- **`import "@/shared/lib/dpr-cap"`** — export 없는 부수효과 모듈. 캔버스를 만들기 전에 import한 곳에서만 의미가 있습니다.
- **`SideDrawer`** / **`AnimatedSelect`** / **`CountBadge`** / **`LabeledField`** / **`SegmentedControl`** — 공용 UI 프리미티브 컴포넌트.
- **`UPlotChart`** — 공용 차트 래퍼. `options` + (`data` 또는 `source`)에 `yRange`/`xRange`/`seriesShow`/`streamFollow`/`yZoom`을 조합합니다. `source.read(view?)`는 `{xMin, xMax, pxWidth}` 뷰포트를 받아 그 구간 데이터만 돌려주면 됩니다. 줌 상태에서는 요청 범위가 좌우로 각각 50%(`SOURCE_OVERREAD`) 넓어지고 `pxWidth`도 2배로 들어옵니다. 구현 쪽은 넘겨받은 범위를 그대로 잘라 주면 그만입니다.
- **`SplashGate({ children })`**(`components/splash/SplashGate.tsx`) — `children`을 그대로 렌더하면서 그 위에 `LoadingSplash`를 겹치는 게이트. 로딩 화면이 떠 있는 동안 `document.body.style.overflow`를 `hidden`으로 잠그고 ENTER 이후 원래 값으로 되돌립니다.
- **`LoadingSplash({ onFinish, durationMs?, sparkles? })`**(`components/splash/LoadingSplash.tsx`) — 로딩 화면 본체. `durationMs`(기본 4500)를 채우는 smoothstep 곡선으로 진행률을 올리고 100%에서 ENTER 버튼을 띄웁니다. ENTER를 누르면 원형 와이프 0.9초와 페이드아웃 0.5초를 거쳐 `onFinish`를 호출합니다. `sparkles`(기본 `true`)는 커서 이동 시 뿌리는 파티클을 끄는 스위치입니다. 진행률은 실제 초기화 진행도가 아니라 타이머 값입니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — `tauri-bridge/`를 별도 도메인으로 분리한 뒤 남은 부분을 반영했습니다. `lib/i18n/`(`LocaleProvider`, `messages/{en,ko}`)을 새로 들여와 일부 컴포넌트에 연결하는 중인 현재 상태와 `ko.ts` 타입 오류 160건까지 담았습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: 차트 렌더 인프라 편입을 반영 — `frame-scheduler.ts`(rAF 단일 루프)·`dpr-cap.ts`(DPR ≤ 1.5)·`element-rect.ts`·`uplot-y-zoom.ts`가 들어오고 `UPlotChart`가 뷰포트 기반 `source.read({xMin,xMax,pxWidth})`/`streamFollow`/`yZoom`/`seriesShow`로 확장됐습니다. i18n 계층은 92fbb5a에서 되돌려 제거됐고(README에 남아 있던 서술 정리), `Sidebar.tsx`는 dashboard 도메인으로 이동, `FullscreenOverlay.tsx`는 삭제, 훅 3파일은 `useGlobalKey.ts` 하나로 통합(`useOverlayTransition` 삭제)됐습니다. `lib/iron-perf/`가 신규 하위 도메인으로 추가돼 참조만 남깁니다. 섹션 1~5 부분 갱신 (커밋 범위: a465514..24d1daa)
- 2026-08-20: 앱 시작 로딩 화면 `components/splash/`(`SplashGate.tsx`/`LoadingSplash.tsx`)가 신규 편입돼 `app/layout.tsx`가 Provider 트리 가장 안쪽에서 마운트합니다. 같은 기간 `UPlotChart`에는 `SOURCE_OVERREAD = 0.5`가 들어왔습니다. 줌 상태의 `source.read()` 요청 범위가 좌우로 각각 50% 넓어지고 `pxWidth`도 2배가 됐습니다(스케일 변경 직후 한 프레임 동안 옛 데이터가 새 범위를 덮게 하려는 조치). 섹션 1~5 부분 갱신 (커밋 범위: b0db42d..HEAD, 작업 트리의 커밋되지 않은 변경 포함)
