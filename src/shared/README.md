# shared

## 1. 도메인 설명

특정 도메인에 속하지 않는 앱 공용 코드를 모아 둔 폴더다. 범용 UI 컴포넌트(`components/` — 폼·표시 프리미티브 `ui/`, 슬라이드 드로어·전체화면 오버레이 셸 `overlay/`, 앱 네비 셸 `Sidebar.tsx`), 공용 훅(`hooks/` — ESC 닫기·오버레이 전환), 순수 유틸 함수 모음(`lib/utils.ts`), 데스크톱 브리지의 전역 타입 선언(`types/electron-bridge.d.ts`), Tauri 셸에서 같은 브리지 계약을 재구현하는 TS shim(`lib/tauri-bridge/`)으로 구성된다. 런타임 상태나 도메인 로직은 갖지 않는다. 단 `Sidebar.tsx`만 예외로 `features/audio` 컨텍스트를 역참조한다(4절).

## 2. 프로젝트 전반에서의 역할

`features/audio` 전역에서 스타일 병합(`cn`)·시간/용량 포맷 같은 공통 유틸을 이 폴더에서 가져다 쓴다. `Sidebar.tsx`는 좌측 고정 네이비 사이드바로 `DashboardClient.tsx`가 마운트하고, 내비 항목이 `useActiveDrawer()`로 우측 드로어(Workspace/측정 기록/Calibration)를 배타적으로 여닫는다. `SegmentedControl.tsx`는 슬라이딩 필 토글로, 현재는 보호 감쇠 비교 패널의 채널(L/R/Both) 토글이 쓴다. `AnimatedSelect.tsx`는 Calibration 드로어의 모든 드롭다운(`CalibrationDrawer.tsx`, `DeviceSelectField.tsx`)을 담당한다. `electron-bridge.d.ts`는 `declare global`로 `Window` 타입을 확장해 `window.audioDevice` / `window.audioCapture` / `window.audioPlayCapture` / `window.localFolder`를 쓰는 파일들(`useNativeCapture.ts`, `useNativeAudioDevice.ts`, `useCalibrationApply.ts`, `useCaptureSession.ts`, `useLocalFolderConnection.ts`, `WorkspaceFolderSection.tsx`, `lib/local-folder.ts` 등)에 타입 안전을 제공한다.

네 브리지는 데스크톱 빌드에서만 채워진다 — Electron(`build:electron`)에서는 `electron/preload.js`가 `contextBridge`로, Tauri(`build:tauri`)에서는 `lib/tauri-bridge/index.ts`의 `installTauriBridge()`가 `window.__TAURI_INTERNALS__` 존재를 감지해 같은 시그니처로 노출한다. **브라우저/모바일 빌드에서는 어느 쪽도 없어 전부 `undefined`다**. 그래서 타입도 전부 옵셔널(`audioDevice?:` 등)로 선언했고, 렌더러 코드는 셸을 구분하지 않고 feature-detect(`typeof window.audioDevice !== "undefined"` 류)만으로 두 데스크톱 셸과 브라우저 폴백을 동일하게 다룬다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `components/Sidebar.tsx` | 좌측 고정 네이비 사이드바(`Header.tsx` 대체). 로고 + 내비 4개(대시보드/Workspace/측정 기록/Calibration)를 배치한다. "대시보드"는 `closeDrawer()`로 드로어를 모두 닫고, 나머지 3개는 `openDrawer(key)`로 해당 우측 드로어를 연다(`active`로 선택 상태 표시). lg 미만에서는 햄버거로 여는 슬라이드 오버레이(`mobileOpen`/`onMobileClose`), lg 이상에서는 항상 고정 표시. 실제 드로어 패널은 `DashboardClient`가 마운트하고 이 컴포넌트는 트리거만 담당한다. |
| `components/ui/AnimatedSelect.tsx` | 네이티브 `<select>` 대체 커스텀 드롭다운. 열림/닫힘 양방향 트랜지션, 뷰포트 하단 공간 부족 시 위로 flip(옵션당 ~36px·최대 240px 기준), 옵션 진입 stagger(항목당 22ms·최대 8개), 키보드 내비게이션(↑/↓/Home/End/Enter/Esc)과 `role=listbox/option` + `aria-activedescendant` 접근성을 갖춘다. `SelectOption { value, label?, hint? }`와 `unit`(예: "Hz") props 지원 |
| `components/ui/SegmentedControl.tsx` | 슬라이딩 필 인디케이터 세그먼트 토글. 항상 네이비 활성 배경을 쓰고 인디케이터가 `translateX`로 선택 항목 위로 이동한다. 제네릭 `<T extends string>` 값에 `{ value, options, onChange, size?, className?, "aria-label"? }` props. `role=tablist/tab` 접근성. 옵션 타입 `SegmentedControlOption`은 내부 전용(export 안 함). |
| `components/ui/LabeledField.tsx` | "라벨 + 컨트롤" 폼 레이아웃 프리미티브. `flex flex-col gap-1.5` 래퍼 + 소문자 트래킹 라벨을 그리고, 실제 컨트롤은 children으로 받는다. `headerRight`(라벨 우측 슬롯)가 있으면 라벨과 한 줄, `footnote`(컨트롤 아래 안내)를 지원. calibration의 `SelectField`/`NumberField`/`DeviceSelectField`가 공유. |
| `components/ui/CountBadge.tsx` | 섹션 헤더 우측의 "초록 점 + 개수(+접미사)" 배지. `{ count, suffix? }` props. `WorkspaceFolderSection`/`RecordsDrawer`/`ChannelSelectDrawer` 섹션 헤더가 공유. |
| `components/overlay/SideDrawer.tsx` | 우측 슬라이드 드로어 공용 셸(백드롭 + 우측 패널 + 기본/커스텀 헤더 + 본문 + 푸터 슬롯). `layer`(`"content"` absolute z-40/50 ↔ `"overlay"` fixed z-[61]/[62])·`safeAreaTop`·`title`/`count`/`header`/`footer`/`bodyClassName` props. ESC 닫기는 각 드로어가 `useEscapeKey`로 직접 관리(셸이 강제하지 않음). Workspace/Records/Calibration/ChannelSelect 4개 드로어가 공유. |
| `components/overlay/FullscreenOverlay.tsx` | 전체화면 오버레이 공용 루트 셸(`fixed inset-0 z-[60]` + safe-area + 진입/이탈 트랜지션). `useOverlayTransition`의 `show`를 받아 트랜지션 클래스만 그리고 헤더/본문은 children으로 받는다. `ChartDetailOverlay`/`ChannelViewerOverlay`가 공유. |
| `hooks/useEscapeKey.ts` | `useEscapeKey(handler, enabled?)` — ESC 키로 `handler` 호출. `enabled`가 false면 리스너 미등록. `handler`는 ref로 참조해 매 렌더 새 함수를 넘겨도 재구독하지 않는다. 4개 드로어 공유. |
| `hooks/useOverlayTransition.ts` | `useOverlayTransition(onClose, durationMs=250)` → `{ show, close }`. 마운트 직후 rAF로 `show=true`(진입), `close()`는 `show=false` 후 `durationMs` 뒤 `onClose` 호출(이탈). ESC 닫기 포함(`useEscapeKey` 조합). 두 전체화면 오버레이 공유. |
| `lib/utils.ts` | 순수 유틸 4종: `cn()`(clsx+tailwind-merge 클래스 병합), `formatTime()`(초 → "MM:SS"), `formatFileSize()`(바이트 → "N.N MB"), `downloadBlob()`(임시 `<a>` 클릭으로 Blob 다운로드) |
| `types/electron-bridge.d.ts` | 4개 브리지(`audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`)의 전역 `Window` 타입 선언과 결과 타입들(`AudioDeviceListResult`, `AudioDeviceQueryResult`, `AudioCaptureStartResult`, `LocalFolderSelectResult` 등). 이름은 Electron 시절 그대로지만 지금은 `electron/preload.js`와 `lib/tauri-bridge/`가 공통으로 준수하는 계약 타입이다(둘 중 어느 쪽이 채우든 이 시그니처와 100% 일치해야 한다) — 수정 시 양쪽 구현을 함께 갱신할 것. `AudioInputDevice`, `LocalAudioFileEntry` 2개는 named export로 외부에서 직접 import한다 |
| `lib/tauri-bridge/` | Tauri 셸 전용 TS shim. `installTauriBridge()`가 `window.__TAURI_INTERNALS__` 감지 시에만 4개 전역을 `electron-bridge.d.ts`와 동일 시그니처로 채운다(Rust `#[tauri::command]`를 `@tauri-apps/api`의 `invoke`/`Channel`/`listen`으로 감싸는 어댑터). `src/app/TauriBridgeInit.tsx`가 모듈 스코프(React 마운트 이전)에서 동기 호출한다 — Electron 빌드에서는 이 모듈 자체가 아무 동작도 하지 않는다(가드 조기 return) |

## 4. 의존성 및 흐름

- **외부 → shared**: `features/audio`의 컴포넌트/훅/렌더 유틸 다수가 `@/shared/*`를 import한다. `lib/utils.ts`가 가장 널리 쓰이고, `Sidebar`는 `DashboardClient` 1곳, `ui/SegmentedControl`은 `DashboardClient`와 두 차트(`TemperatureChart`/`ExcursionChart`), `ui/AnimatedSelect`·`ui/LabeledField`는 calibration 도메인, `ui/CountBadge`는 workspace·channel 섹션 헤더, `overlay/SideDrawer`·`hooks/useEscapeKey`는 4개 드로어(workspace·calibration·channel), `overlay/FullscreenOverlay`·`hooks/useOverlayTransition`은 두 전체화면 오버레이(chart·workspace)가 import한다. 타입은 `useNativeAudioDevice.ts`(`AudioInputDevice`)와 `lib/local-folder.ts`(`LocalAudioFileEntry`)가 import한다.
- **shared → 외부**: `Sidebar.tsx`가 `@/features/audio`의 `ActiveDrawerContext`(`useActiveDrawer`/`DrawerKey`)와 `CalibrationContext`(`useCalibration`)를 역방향 import한다. shared 안에서 features를 참조하는 유일한 지점이다.
- **shared → 라이브러리**: `clsx`, `tailwind-merge`(utils), `lucide-react`, React 훅, `lib/tauri-bridge/`는 `@tauri-apps/api`(`core`/`event`)를 쓴다.
- **타입 ↔ 구현 대응 (Electron·Tauri 공통 계약)**: `electron-bridge.d.ts`의 메서드 시그니처는 `electron/preload.js`의 `contextBridge.exposeInMainWorld` 블록들과, 그리고 `lib/tauri-bridge/`의 `installTauriBridge()`가 채우는 4개 전역과 각각 1:1 대응한다(`audioDevice.list/getConfig/setConfig/query`, `audioCapture.start/stop/onData/onEnded`, `audioPlayCapture.startWrite/writeChunk/finalizeWrite/cancelWrite/start/control/stop/onData/onEnded`, `localFolder.select/unwatch/readFile/onChanged`). `onData`/`onEnded`/`onChanged`는 구독 해제 함수를 반환하는 이벤트 구독 패턴이며, Tauri 쪽은 `listen()`의 비동기 Promise를 동기 시그니처로 감싸 이 계약을 맞춘다(TAURI_MIGRATION_PLAN.md 5.7). 이 타입 파일을 고치면 preload.js와 tauri-bridge 양쪽을 함께 갱신해야 한다 — 렌더러 코드(`src/features/audio/`)는 어느 쪽이 채웠는지 전혀 구분하지 않는다.

## 5. 주요 인터페이스 / 진입점

- `cn(...inputs: ClassValue[])` — Tailwind 클래스 조건부 병합. 프로젝트 표준.
- `formatTime(seconds: number): string` / `formatFileSize(bytes: number): string` / `downloadBlob(blob: Blob, filename: string): void`
- `<Sidebar mobileOpen? onMobileClose? />` — `DashboardClient.tsx`가 유일한 사용처. 내비 항목이 `useActiveDrawer()`로 드로어를 여닫는다.
- `<SegmentedControl<T> value options onChange size? className? aria-label? />` — 슬라이딩 필 토글. 옵션 타입 `SegmentedControlOption`은 컴포넌트 내부 전용.
- `<AnimatedSelect value options onChange placeholder? unit? disabled? />` + `SelectOption` 타입.
- `<LabeledField label headerRight? footnote?>{children}</LabeledField>` — 라벨+컨트롤 폼 레이아웃. `headerRight`가 있으면 라벨과 한 줄.
- `<CountBadge count suffix? />` — 초록 점 + 개수(+접미사) 배지.
- `<SideDrawer open onClose ariaLabel layer? safeAreaTop? title? count? header? footer? bodyClassName?>{children}</SideDrawer>` — 우측 슬라이드 드로어 셸. ESC 닫기는 소비자가 `useEscapeKey`로 관리.
- `<FullscreenOverlay show ariaLabel>{children}</FullscreenOverlay>` — 전체화면 오버레이 루트 셸. `show`는 `useOverlayTransition`에서 받는다.
- `useEscapeKey(handler: () => void, enabled?: boolean): void` — ESC로 `handler` 호출. `enabled=false`면 미등록.
- `useOverlayTransition(onClose: () => void, durationMs?: number): { show, close }` — 오버레이 진입/이탈 전환 + ESC 닫기. `close()`는 `durationMs`(기본 250) 뒤 `onClose` 호출.
- `window.audioDevice?` / `window.audioCapture?` / `window.audioPlayCapture?` / `window.localFolder?` — 데스크톱 전용 전역(Electron은 `preload.js`, Tauri는 `lib/tauri-bridge/`가 채운다). 브라우저/모바일 빌드에서는 `undefined`이므로 feature-detect 필수. `audioDevice`/`audioCapture`의 `deviceUID` 인자는 생략 시 OS 기본 입력 장치를 대상으로 한다.
- `installTauriBridge()`(`lib/tauri-bridge/index.ts`) — Tauri 런타임 감지 시에만 위 4개 전역을 채우는 설치 함수. `src/app/TauriBridgeInit.tsx`가 모듈 스코프에서 1회 호출한다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: Split Studio/Navy Shell 디자인 시스템 마이그레이션 반영 — `Header.tsx`(상단 헤더) 삭제, `Sidebar.tsx`(좌측 네이비 내비, `ActiveDrawerContext`로 드로어 트리거) 신규, `SegmentedControl.tsx`(파일/마이크·차트 채널 토글 공용) 신규. 섹션 1·2·3·4·5 갱신 (커밋 범위: e0add14..HEAD, 워크트리 포함)
- 2026-07-10: 공용 부품 확충 + 구조 재편 반영 — 리팩터로 중복 제거한 공용 컴포넌트/훅 신설: `overlay/SideDrawer`·`overlay/FullscreenOverlay`(드로어·오버레이 셸), `ui/LabeledField`·`ui/CountBadge`(폼 레이아웃·카운트 배지), `hooks/useEscapeKey`·`hooks/useOverlayTransition`(ESC 닫기·오버레이 전환). `components/`를 성격별로 `ui/`(프리미티브)·`overlay/`(셸)로 그룹핑하고(`AnimatedSelect`/`SegmentedControl` 경로 이동), 공용 훅 카테고리 `hooks/` 신설. `Sidebar.tsx`는 앱 네비 셸이라 root 유지. 섹션 1·3·4·5 갱신 (커밋 범위: e2cc41a..HEAD, 워크트리 포함)
- 2026-07-28: `findFrameIndex()` 삭제 반영 — 유일한 소비자였던 `lib/render/chart-window.ts`의 비스트리밍 창 분기가 없어지면서 이 함수도 함께 제거했다(`lib/utils.ts`는 유틸 4종). `SegmentedControl.tsx` 설명에서 대시보드 입력 소스(파일/마이크) 토글을 뺐다 — 마이크 패널 제거로 그 소비자가 사라져 지금은 채널(L/R/Both) 토글만 쓴다. 이번 변경과 무관한 선행 드리프트는 손대지 않았다. 섹션 1·3·5 부분 갱신 (커밋 범위: 3124dd9..HEAD — 이번 변경분만, 8727e29 이후 선행 드리프트는 미반영)
- 2026-07-29: Tauri v2 셸 병행 추가 반영 — `lib/tauri-bridge/`(신규, `installTauriBridge()`가 Tauri 런타임에서만 4개 전역을 `electron-bridge.d.ts`와 동일 시그니처로 채우는 TS shim) 추가. `electron-bridge.d.ts`는 이제 Electron `preload.js`뿐 아니라 이 shim도 함께 따르는 공통 계약임을 명시. 섹션 1·2·3·4·5 부분 갱신 (Phase 5 빌드 체계 작업 범위 — src-tauri/ 자체 구현은 선행 커밋에서 완료됨)
