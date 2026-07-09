# shared

## 1. 도메인 설명

특정 도메인에 속하지 않는 앱 공용 코드를 모아 둔 폴더다. 범용 UI 컴포넌트 3개(`Sidebar.tsx`, `AnimatedSelect.tsx`, `SegmentedControl.tsx`), 순수 유틸 함수 모음(`lib/utils.ts`), Electron 프리로드 브리지의 전역 타입 선언(`types/electron-bridge.d.ts`)으로 구성된다. 런타임 상태나 도메인 로직은 갖지 않는다.

## 2. 프로젝트 전반에서의 역할

`features/audio` 전역에서 스타일 병합(`cn`)·시간/용량 포맷·프레임 인덱스 탐색 같은 공통 유틸을 이 폴더에서 가져다 쓴다. `Sidebar.tsx`는 좌측 고정 네이비 사이드바로 `DashboardClient.tsx`가 마운트하고, 내비 항목이 `useActiveDrawer()`로 우측 드로어(Workspace/측정 기록/Calibration)를 배타적으로 여닫는다. `SegmentedControl.tsx`는 슬라이딩 필 토글로 대시보드 상단 입력 소스(파일/마이크) 토글과 차트 채널(L/R/Both) 토글이 공유한다. `AnimatedSelect.tsx`는 Calibration 드로어의 모든 드롭다운(`CalibrationDrawer.tsx`, `DeviceSelectField.tsx`)을 담당한다. `electron-bridge.d.ts`는 `declare global`로 `Window` 타입을 확장해 `window.audioDevice` / `window.audioCapture` / `window.localFolder`를 쓰는 파일들(`useNativeCapture.ts`, `useNativeAudioDevice.ts`, `useCalibrationApply.ts`, `useCaptureSession.ts`, `useLocalFolderConnection.ts`, `WorkspaceFolderSection.tsx`, `lib/local-folder.ts` 등)에 타입 안전을 제공한다.

세 브리지는 Electron 데스크톱 빌드(`build:electron`)에서만 `electron/preload.js`가 `contextBridge`로 노출하며 **브라우저/모바일 빌드에서는 전부 `undefined`다**. 그래서 타입도 전부 옵셔널(`audioDevice?:` 등)로 선언했고 사용하는 쪽은 반드시 feature-detect(`typeof window.audioDevice !== "undefined"` 류) 후 호출해야 한다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `components/Sidebar.tsx` | 좌측 고정 네이비 사이드바(`Header.tsx` 대체). 로고 + 내비 4개(대시보드/Workspace/측정 기록/Calibration)를 배치한다. "대시보드"는 `closeDrawer()`로 드로어를 모두 닫고, 나머지 3개는 `openDrawer(key)`로 해당 우측 드로어를 연다(`active`로 선택 상태 표시). lg 미만에서는 햄버거로 여는 슬라이드 오버레이(`mobileOpen`/`onMobileClose`), lg 이상에서는 항상 고정 표시. 실제 드로어 패널은 `DashboardClient`가 마운트하고 이 컴포넌트는 트리거만 담당한다. |
| `components/AnimatedSelect.tsx` | 네이티브 `<select>` 대체 커스텀 드롭다운. 열림/닫힘 양방향 트랜지션, 뷰포트 하단 공간 부족 시 위로 flip(옵션당 ~36px·최대 240px 기준), 옵션 진입 stagger(항목당 22ms·최대 8개), 키보드 내비게이션(↑/↓/Home/End/Enter/Esc)과 `role=listbox/option` + `aria-activedescendant` 접근성을 갖춘다. `SelectOption { value, label?, hint? }`와 `unit`(예: "Hz") props 지원 |
| `components/SegmentedControl.tsx` | 슬라이딩 필 인디케이터 세그먼트 토글. 항상 네이비 활성 배경을 쓰고 인디케이터가 `translateX`로 선택 항목 위로 이동한다. 제네릭 `<T extends string>` 값에 `{ value, options, onChange, size?, className?, "aria-label"? }` props. `role=tablist/tab` 접근성. 옵션 타입 `SegmentedControlOption`은 내부 전용(export 안 함). |
| `lib/utils.ts` | 순수 유틸 5종: `cn()`(clsx+tailwind-merge 클래스 병합), `formatTime()`(초 → "MM:SS"), `findFrameIndex()`(재생 시간 → 프레임 인덱스, 이진 탐색), `formatFileSize()`(바이트 → "N.N MB"), `downloadBlob()`(임시 `<a>` 클릭으로 Blob 다운로드) |
| `types/electron-bridge.d.ts` | `electron/preload.js`가 노출하는 3개 브리지의 전역 `Window` 타입 선언과 결과 타입들(`AudioDeviceListResult`, `AudioDeviceQueryResult`, `AudioCaptureStartResult`, `LocalFolderSelectResult` 등). `AudioInputDevice`, `LocalAudioFileEntry` 2개는 named export로 외부에서 직접 import한다 |

## 4. 의존성 및 흐름

- **외부 → shared**: `features/audio`의 컴포넌트/훅/렌더 유틸 다수가 `@/shared/*`를 import한다. `lib/utils.ts`가 가장 널리 쓰이고, `Sidebar`는 `DashboardClient` 1곳, `SegmentedControl`은 `DashboardClient`와 두 차트(`TemperatureChart`/`ExcursionChart`), `AnimatedSelect`는 calibration 도메인, 타입은 `useNativeAudioDevice.ts`(`AudioInputDevice`)와 `lib/local-folder.ts`(`LocalAudioFileEntry`)가 import한다.
- **shared → 외부**: `Sidebar.tsx`가 `@/features/audio`의 `ActiveDrawerContext`(`useActiveDrawer`/`DrawerKey`)와 `CalibrationContext`(`useCalibration`)를 역방향 import한다. shared 안에서 features를 참조하는 유일한 지점이다.
- **shared → 라이브러리**: `clsx`, `tailwind-merge`(utils), `lucide-react`, React 훅만 쓴다.
- **타입 ↔ preload 대응**: `electron-bridge.d.ts`의 메서드 시그니처는 `electron/preload.js`의 `contextBridge.exposeInMainWorld` 3블록과 1:1 대응한다(`audioDevice.list/getConfig/setConfig/query`, `audioCapture.start/stop/onData/onEnded`, `localFolder.select/unwatch/readFile/onChanged`). `onData`/`onEnded`/`onChanged`는 구독 해제 함수를 반환하는 이벤트 구독 패턴이다. preload를 고치면 이 파일을 함께 갱신해야 한다.

## 5. 주요 인터페이스 / 진입점

- `cn(...inputs: ClassValue[])` — Tailwind 클래스 조건부 병합. 프로젝트 표준.
- `formatTime(seconds: number): string` / `formatFileSize(bytes: number): string` / `downloadBlob(blob: Blob, filename: string): void`
- `findFrameIndex(times: number[], currentTime: number): number` — `ChartDetailOverlay`와 `lib/render/chart-window.ts`가 재생 위치 → 차트 프레임 매핑에 쓴다.
- `<Sidebar mobileOpen? onMobileClose? />` — `DashboardClient.tsx`가 유일한 사용처. 내비 항목이 `useActiveDrawer()`로 드로어를 여닫는다.
- `<SegmentedControl<T> value options onChange size? className? aria-label? />` — 슬라이딩 필 토글. 옵션 타입 `SegmentedControlOption`은 컴포넌트 내부 전용.
- `<AnimatedSelect value options onChange placeholder? unit? disabled? />` + `SelectOption` 타입.
- `window.audioDevice?` / `window.audioCapture?` / `window.localFolder?` — Electron 전용 전역. 브라우저/모바일 빌드에서는 `undefined`이므로 feature-detect 필수. `audioDevice`/`audioCapture`의 `deviceUID` 인자는 생략 시 OS 기본 입력 장치를 대상으로 한다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: Split Studio/Navy Shell 디자인 시스템 마이그레이션 반영 — `Header.tsx`(상단 헤더) 삭제, `Sidebar.tsx`(좌측 네이비 내비, `ActiveDrawerContext`로 드로어 트리거) 신규, `SegmentedControl.tsx`(파일/마이크·차트 채널 토글 공용) 신규. 섹션 1·2·3·4·5 갱신 (커밋 범위: e0add14..HEAD, 워크트리 포함)
