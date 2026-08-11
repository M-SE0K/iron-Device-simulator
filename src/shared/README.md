# shared

## 1. 도메인 설명

여러 도메인이 공통으로 쓰는 UI 프리미티브(드로어/오버레이/셀렉트 등), 앱 전역 피드백(에러/성공 팝업), 모든 차트가 공유하는 uPlot 래퍼, 그 밖의 자잘한 유틸(문자열·파일·시간 포맷, IPC 에러 메시지 변환, 파일 저장)을 모아둔 도메인입니다. `tauri-bridge/`는 별도 도메인으로 떼어놨습니다.

## 2. 프로젝트 전반에서의 역할

`features/audio`의 거의 모든 컴포넌트 도메인이 기대는 하부 인프라입니다. `SideDrawer`/`FullscreenOverlay`/`AnimatedSelect`/`CountBadge`/`LabeledField`/`SegmentedControl`은 여러 드로어·오버레이가 반복해서 복붙하던 마크업을 한곳으로 모았습니다. `ErrorPopupContext`는 화면 곳곳에 흩어져 있던 에러/성공 피드백을 중앙 모달 하나로 통일합니다. `UPlotChart`는 메인 차트·채널 파형·보호 감쇠 비교가 공유하는 유일한 uPlot 접점이라 인스턴스 생명주기와 리사이즈·줌 보존 규칙이 차트마다 갈리지 않게 붙잡아 줍니다.

표시 언어(i18n) 지원은 이 도메인에 없습니다. `lib/i18n/`(`LocaleProvider`, `messages/{en,ko}`)은 2026-08-03 `92fbb5a`에서 배선째로 되돌려졌습니다. 지금 앱의 표시 문자열은 전부 각 컴포넌트 안에 영문으로 박혀 있습니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `components/Sidebar.tsx` | 좌측 네비게이션 — 드로어(Workspace/Records/Calibration) 트리거 |
| `components/overlay/SideDrawer.tsx` | 우측 슬라이드 드로어 공용 셸 |
| `components/overlay/FullscreenOverlay.tsx` | 전체 화면 오버레이 공용 셸 |
| `components/error-popup/{ErrorPopupContext.tsx, ErrorPopupModal.tsx, popup-types.ts}` | 앱 전역 에러/성공 피드백 큐 + 중앙 모달 |
| `components/ui/{AnimatedSelect.tsx, CountBadge.tsx, LabeledField.tsx, SegmentedControl.tsx}` | 공용 UI 프리미티브(커스텀 셀렉트, 개수 배지, 라벨+컨트롤 레이아웃, 세그먼트 토글) |
| `components/UPlotChart.tsx` | uPlot 인스턴스 생성·갱신을 감싸는 공용 래퍼 — data(React 상태) 모드와 source(구독 기반) 모드, 시리즈 토글, 스트리밍 추종, y축 줌 옵션 지원 |
| `hooks/{useCtrlBToggle.ts, useEscapeKey.ts, useOverlayTransition.ts}` | 키보드 단축키(Ctrl/Cmd+B, Escape)와 오버레이 진입/이탈 전환 공용 훅 |
| `lib/uplot-y-zoom.ts` | y축 gutter 위에서의 확대/이동(`attachYZoom`) — 플러그인이 아니라 `UPlotChart`가 직접 붙이는 헬퍼 |
| `lib/download.ts` | `downloadBlob()` — Tauri 런타임이면 저장 다이얼로그 커맨드로, 일반 브라우저면 앵커 다운로드로 분기 |
| `lib/ipc-error.ts` | 네이티브 IPC/헬퍼의 짧은 에러 코드를 사용자용 문장으로 변환 |
| `lib/utils.ts` | `cn`/`formatTime`/`round3`/`formatFileSize`/`splitFileName`/`sanitizeFileName`/`splitPath` |
| `lib/yield-to-main.ts` | 메인 스레드를 짧게 양보하는 `yieldToMain()` |
| `types/native-bridge.d.ts` | `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`/`wasmAsset` 타입 계약(Tauri shim이 채움) |

## 4. 의존성 및 흐름

- **가져오는 것**: `clsx`/`tailwind-merge`(`cn`), `uplot`(래퍼와 y축 줌 헬퍼). `lib/download.ts`의 `downloadBlob()`은 `tauri-bridge/file-export`의 `saveFileViaTauri()`로 위임합니다 — 이 도메인이 `tauri-bridge/`를 직접 가져오는 유일한 지점입니다.
- **소비하는 도메인**: 사실상 `features/audio` 전역입니다. Calibration/Workspace/Records/View 드로어는 모두 `SideDrawer` 위에 얹혀 있습니다. `FullscreenOverlay`를 쓰는 곳은 현재 `workspace/ChannelViewerOverlay` 하나입니다. 두 메인 차트와 채널 파형·보호 감쇠 비교 차트는 전부 `UPlotChart`를 거칩니다.
- **차트 래퍼의 역할 분담**: x축 줌은 `features/audio/lib/render/uplot-plugins/zoom.ts`가 uPlot 플러그인으로 처리하지만 y축 줌은 `UPlotChart`가 `attachYZoom`으로 직접 붙입니다. y 범위를 쥔 쪽이 옵션의 `scales.y.range`가 아니라 `UPlotChart`가 소유한 ref이기 때문입니다. 플러그인은 그 ref에 닿을 수 없습니다. 휠 배율도 x축(0.75)보다 완만한 0.85로 잡아 세밀하게 조정됩니다.

```
app/layout.tsx → ErrorPopupProvider 마운트

어디서든 useErrorPopup().showError()/showSuccess() 호출 → 큐 적재 → ErrorPopupModal이 중앙에 표시

차트 컴포넌트 → UPlotChart(options + data 또는 source)
  → source 모드: subscribe()로 스토어 구독 → rAF마다 read(view)로 보이는 구간만 커밋
  → yZoom 옵션: attachYZoom()이 y축 gutter 이벤트를 잡아 UPlotChart의 yRange ref를 덮어씀
```

## 5. 주요 인터페이스 / 진입점

- **`cn(...inputs)`** / **`formatTime(seconds)`** / **`round3(v)`** / **`formatFileSize(bytes)`** / **`splitFileName(name)`** / **`sanitizeFileName(name)`** / **`splitPath(path)`** — `lib/utils.ts`의 범용 유틸.
- **`downloadBlob(blob, filename): Promise<void>`** — `lib/download.ts`. Tauri에서는 blob + `<a download>`로 저장 다이얼로그를 띄울 수 없어 네이티브 커맨드로 우회합니다.
- **`humanizeIpcError(raw, fallback): string`** — 알려진 IPC 에러 코드·fs errno·이미 사람이 쓴 문장을 구분해 사용자용 메시지로 바꿉니다.
- **`yieldToMain(): Promise<void>`** — `scheduler.yield()`가 있으면 그걸, 없으면 `MessageChannel`로 매크로태스크 양보.
- **`useErrorPopup(): { showError, showSuccess }`** — `ErrorPopupProvider` 트리 안에서만 호출 가능.
- **`useCtrlBToggle(handler)`** / **`useEscapeKey(handler, enabled?)`** / **`useOverlayTransition(onClose, durationMs?): { show, close }`** — 공용 키보드/전환 훅.
- **`SideDrawer`** / **`FullscreenOverlay`** / **`AnimatedSelect`** / **`CountBadge`** / **`LabeledField`** / **`SegmentedControl`** — 공용 UI 프리미티브 컴포넌트.
- **`UPlotChart`** (default export) — `options` + (`data` 또는 `source`) 조합으로 uPlot 인스턴스를 관리하는 공용 차트 래퍼. 선택 prop은 `yRange`/`xRange`(고정 도메인), `seriesShow`(인스턴스 재생성 없는 시리즈 토글), `streamFollow`(라이브 추종), `yZoom`(y축 gutter 줌 활성), `onUserZoom`, `className`입니다.
- **`UPlotOptions`** (type) — `uPlot.Options`에서 `width`/`height`를 뺀 형태. 크기는 래퍼가 컨테이너에서 잡습니다.
- **`UPlotDataSource`** (type) — `{ subscribe(cb): () => void; read(view?): { data, yRange?, xFull? } }`. `read`가 받는 `view`에는 현재 x 범위와 픽셀 폭이 담겨 있어, 스토어가 화면에 필요한 만큼만 채워 낼 수 있습니다.
- **`attachYZoom(u, ctrl: YZoomController): () => void`** — y축 gutter 조작을 붙이고 해제 함수를 돌려줍니다. `ctrl.getAuto()`가 자동 범위를, `ctrl.apply(range | null)`가 적용을 맡습니다(`null`은 잠금 해제).

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — `tauri-bridge/`를 별도 도메인으로 분리한 뒤 남은 부분을 반영했습니다. `lib/i18n/`(`LocaleProvider`, `messages/{en,ko}`)을 새로 들여와 일부 컴포넌트에 연결하는 중인 현재 상태와 `ko.ts` 타입 오류 160건까지 담았습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-11: i18n 철수와 차트 래퍼 확장을 반영했습니다. `lib/i18n/` 전체가 2026-08-03 `92fbb5a`에서 되돌려져 §1·§2·§3·§4·§5의 `LocaleProvider`/`useLocale()`/메시지 카탈로그 서술과 "i18n 배선 현황" 항목(`ko.ts` 타입 오류 160건 포함)을 걷어냈습니다. `Sidebar`의 역할에서도 언어 전환 UI가 빠졌습니다. `lib/frame-scheduler.ts`는 삭제됐고 참조도 남아 있지 않습니다. `downloadBlob()`은 `lib/utils.ts`에서 신설 `lib/download.ts`로 분리됐습니다. y축 줌 헬퍼 `lib/uplot-y-zoom.ts`가 새로 들어와 `UPlotChart`의 `yZoom` prop을 받칩니다. `UPlotChart`는 `source` 모드의 `read(view)`가 뷰포트를 인자로 받는 형태로 바뀌고 `seriesShow`/`streamFollow`/`yZoom` prop이 추가됐습니다. §4의 소비처에서 삭제된 `ChartDetailOverlay` 언급을 지웠습니다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: a465514..HEAD, 작업 트리 포함)
