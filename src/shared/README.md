# shared

## 1. 도메인 설명

여러 도메인이 공통으로 쓰는 UI 프리미티브(드로어/오버레이/셀렉트 등), 앱 전역 피드백(에러/성공 팝업), 표시 언어(i18n) 지원, 그 밖의 자잘한 유틸(문자열·파일·시간 포맷, IPC 에러 메시지 변환)을 모아둔 도메인입니다. `tauri-bridge/`는 별도 도메인으로 떼어놨습니다.

## 2. 프로젝트 전반에서의 역할

`features/audio`의 거의 모든 컴포넌트 도메인이 기대는 하부 인프라입니다. `SideDrawer`/`FullscreenOverlay`/`AnimatedSelect`/`CountBadge`/`LabeledField`/`SegmentedControl`은 여러 드로어·오버레이가 반복해서 복붙하던 마크업을 한곳으로 모았습니다. `ErrorPopupContext`는 화면 곳곳에 흩어져 있던 에러/성공 피드백을 중앙 모달 하나로 통일합니다. `LocaleProvider`는 표시 언어 전환 기능을 제공하고 진입점은 사이드바에 있습니다. 지금은 일부 컴포넌트부터 하나씩 연결해 나가는 중입니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `components/Sidebar.tsx` | 좌측 네비게이션 + 언어 전환 UI |
| `components/overlay/SideDrawer.tsx` | 우측 슬라이드 드로어 공용 셸 |
| `components/overlay/FullscreenOverlay.tsx` | 전체 화면 오버레이 공용 셸 |
| `components/error-popup/{ErrorPopupContext.tsx, ErrorPopupModal.tsx, popup-types.ts}` | 앱 전역 에러/성공 피드백 큐 + 중앙 모달 |
| `components/ui/{AnimatedSelect.tsx, CountBadge.tsx, LabeledField.tsx, SegmentedControl.tsx}` | 공용 UI 프리미티브(커스텀 셀렉트, 개수 배지, 라벨+컨트롤 레이아웃, 세그먼트 토글) |
| `components/UPlotChart.tsx` | uPlot 인스턴스 생성·갱신을 감싸는 공용 래퍼 — data(React 상태) 모드와 source(구독 기반) 모드 지원 |
| `hooks/{useCtrlBToggle.ts, useEscapeKey.ts, useOverlayTransition.ts}` | 키보드 단축키(Ctrl/Cmd+B, Escape)와 오버레이 진입/이탈 전환 공용 훅 |
| `lib/i18n/{locale.ts, LocaleProvider.tsx, messages/{en.ts, ko.ts}}` | 표시 언어 컨텍스트와 메시지 카탈로그 |
| `lib/ipc-error.ts` | 네이티브 IPC/헬퍼의 짧은 에러 코드를 사용자용 문장으로 변환 |
| `lib/utils.ts` | `cn`/`formatTime`/`round3`/`formatFileSize`/`splitFileName`/`sanitizeFileName`/`splitPath`/`downloadBlob`/`downloadJsonArtifact` |
| `lib/yield-to-main.ts` | 메인 스레드를 짧게 양보하는 `yieldToMain()` |
| `types/native-bridge.d.ts` | `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`/`wasmAsset` 타입 계약(Tauri shim이 채움) |

## 4. 의존성 및 흐름

- **가져오는 것**: `clsx`/`tailwind-merge`(`cn`). `lib/utils.ts`의 `downloadBlob()`은 `tauri-bridge/file-export`의 `saveFileViaTauri()`로 위임합니다 — 이 도메인이 `tauri-bridge/`를 직접 가져오는 유일한 지점입니다.
- **소비하는 도메인**: 사실상 `features/audio` 전역입니다. Calibration/Workspace/Records/Channel 드로어는 모두 `SideDrawer` 위에 얹혀 있습니다. `ChartDetailOverlay`/`ChannelViewerOverlay`는 `FullscreenOverlay`를, 두 메인 차트와 채널 파형·보호 비교 차트는 `UPlotChart`를 씁니다.
- **i18n 배선 현황**: `LocaleProvider`는 `app/layout.tsx`에 마운트되어 있습니다. 지금은 `Sidebar`, `SideDrawer`, `ErrorPopupModal`, `workspace/`의 `WorkspaceDrawer`·`WorkspaceFolderSection`이 `useLocale()`을 쓰기 시작했습니다. 나머지 컴포넌트는 아직 하드코딩된 영문 문자열입니다. `messages/ko.ts`는 현재 `npm run typecheck` 기준으로 `en.ts`에서 추론된 `Messages` 타입과 어긋나는 오류가 160건 있습니다(리터럴 문자열 타입 불일치) — 아직 작업 중인 듯합니다.

```
app/layout.tsx → ErrorPopupProvider + LocaleProvider 마운트

어디서든 useErrorPopup().showError()/showSuccess() 호출 → 큐 적재 → ErrorPopupModal이 중앙에 표시
어디서든 useLocale() → { locale, setLocale, t }
  → 사이드바 언어 스위치가 setLocale() 호출 → localStorage 저장 + <html lang> 갱신
```

## 5. 주요 인터페이스 / 진입점

- **`cn(...inputs)`** / **`formatTime(seconds)`** / **`round3(v)`** / **`formatFileSize(bytes)`** / **`splitFileName(name)`** / **`sanitizeFileName(name)`** / **`splitPath(path)`** / **`downloadBlob(blob, filename)`** / **`downloadJsonArtifact(data, prefix, meta, filename?)`** — `lib/utils.ts`의 범용 유틸.
- **`humanizeIpcError(raw, fallback): string`** — 알려진 IPC 에러 코드·fs errno·이미 사람이 쓴 문장을 구분해 사용자용 메시지로 바꿉니다.
- **`yieldToMain(): Promise<void>`** — `scheduler.yield()`가 있으면 그걸, 없으면 `MessageChannel`로 매크로태스크 양보.
- **`useErrorPopup(): { showError, showSuccess }`** — `ErrorPopupProvider` 트리 안에서만 호출 가능.
- **`useLocale(): { locale, setLocale, t: Messages }`** — `LocaleProvider` 트리 안에서만 쓸 수 있습니다.
- **`useCtrlBToggle(handler)`** / **`useEscapeKey(handler, enabled?)`** / **`useOverlayTransition(onClose, durationMs?): { show, close }`** — 공용 키보드/전환 훅.
- **`SideDrawer`** / **`FullscreenOverlay`** / **`AnimatedSelect`** / **`CountBadge`** / **`LabeledField`** / **`SegmentedControl`** — 공용 UI 프리미티브 컴포넌트.
- **`UPlotChart`** — `options` + (`data` 또는 `source`) 조합으로 uPlot 인스턴스를 관리하는 공용 차트 래퍼.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — `tauri-bridge/`를 별도 도메인으로 분리한 뒤 남은 부분을 반영했습니다. `lib/i18n/`(`LocaleProvider`, `messages/{en,ko}`)을 새로 들여와 일부 컴포넌트에 연결하는 중인 현재 상태와 `ko.ts` 타입 오류 160건까지 담았습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
