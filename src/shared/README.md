# shared

## 1. 도메인 설명

특정 도메인에 속하지 않는 앱 공용 코드를 모아 둔 폴더다. 범용 UI 컴포넌트 2개(`Header.tsx`, `AnimatedSelect.tsx`), 순수 유틸 함수 모음(`lib/utils.ts`), Electron 프리로드 브리지의 전역 타입 선언(`types/electron-bridge.d.ts`)으로 구성된다. 런타임 상태나 도메인 로직은 갖지 않는다.

## 2. 프로젝트 전반에서의 역할

`features/audio` 전역에서 스타일 병합(`cn`)·시간/용량 포맷·프레임 인덱스 탐색 같은 공통 유틸을 이 폴더에서 가져다 쓴다. `Header.tsx`는 대시보드 최상단 헤더로 `DashboardClient.tsx`가 마운트하고 `AnimatedSelect.tsx`는 Calibration 드로어의 모든 드롭다운(`CalibrationDrawer.tsx`, `DeviceSelectField.tsx`)을 담당한다. `electron-bridge.d.ts`는 `declare global`로 `Window` 타입을 확장해 `window.audioDevice` / `window.audioCapture` / `window.localFolder`를 쓰는 8개 파일(`useNativeCapture.ts`, `useNativeAudioDevice.ts`, `useCalibrationApply.ts`, `MicrophonePlayer.tsx`, `useLocalFolderConnection.ts`, `WorkspaceFolderSection.tsx`, `lib/local-folder.ts` 등)에 타입 안전을 제공한다.

세 브리지는 Electron 데스크톱 빌드(`build:electron`)에서만 `electron/preload.js`가 `contextBridge`로 노출하며 **브라우저/모바일 빌드에서는 전부 `undefined`다**. 그래서 타입도 전부 옵셔널(`audioDevice?:` 등)로 선언했고 사용하는 쪽은 반드시 feature-detect(`typeof window.audioDevice !== "undefined"` 류) 후 호출해야 한다.

## 3. 파일별 역할
| 파일 | 역할 |
|------|------|
| `components/Header.tsx` | 앱 상단 헤더. 좌측에 `WorkspaceDrawer`(저장 세션·로컬 폴더), 중앙에 로고(`/logo_header.jpeg`), 우측에 `CalibrationDrawer` 트리거를 배치한다. `env(safe-area-inset-top)`으로 모바일 노치 영역을 보정한다(높이 `calc(3.5rem + inset)`). 인증/내비게이션 없음 |
| `components/AnimatedSelect.tsx` | 네이티브 `<select>` 대체 커스텀 드롭다운. 열림/닫힘 양방향 트랜지션, 뷰포트 하단 공간 부족 시 위로 flip(옵션당 ~36px·최대 240px 기준), 옵션 진입 stagger(항목당 22ms·최대 8개), 키보드 내비게이션(↑/↓/Home/End/Enter/Esc)과 `role=listbox/option` + `aria-activedescendant` 접근성을 갖춘다. `SelectOption { value, label?, hint? }`와 `unit`(예: "Hz") props 지원 |
| `lib/utils.ts` | 순수 유틸 5종: `cn()`(clsx+tailwind-merge 클래스 병합), `formatTime()`(초 → "MM:SS"), `findFrameIndex()`(재생 시간 → 프레임 인덱스, 이진 탐색), `formatFileSize()`(바이트 → "N.N MB"), `downloadBlob()`(임시 `<a>` 클릭으로 Blob 다운로드) |
| `types/electron-bridge.d.ts` | `electron/preload.js`가 노출하는 3개 브리지의 전역 `Window` 타입 선언과 결과 타입들(`AudioDeviceListResult`, `AudioDeviceQueryResult`, `AudioCaptureStartResult`, `LocalFolderSelectResult` 등). `AudioInputDevice`, `LocalAudioFileEntry` 2개는 named export로 외부에서 직접 import한다 |

## 4. 의존성 및 흐름

- **외부 → shared**: `features/audio`의 컴포넌트/훅/렌더 유틸 17곳이 `@/shared/*`를 import한다. `lib/utils.ts`가 가장 널리 쓰이고(`cn` 8곳, `formatTime`/`formatFileSize`/`findFrameIndex`/`downloadBlob` 각 1~4곳), `AnimatedSelect`는 calibration 도메인 2곳, 타입은 `useNativeAudioDevice.ts`(`AudioInputDevice`)와 `lib/local-folder.ts`(`LocalAudioFileEntry`)가 import한다.
- **shared → 외부**: `Header.tsx`가 `@/features/audio`의 `CalibrationDrawer`/`WorkspaceDrawer`를 역방향 import한다. shared 안에서 features를 참조하는 유일한 지점이다.
- **shared → 라이브러리**: `clsx`, `tailwind-merge`(utils), `lucide-react`, React 훅(AnimatedSelect)만 쓴다.
- **타입 ↔ preload 대응**: `electron-bridge.d.ts`의 메서드 시그니처는 `electron/preload.js`의 `contextBridge.exposeInMainWorld` 3블록과 1:1 대응한다(`audioDevice.list/getConfig/setConfig/query`, `audioCapture.start/stop/onData/onEnded`, `localFolder.select/unwatch/readFile/onChanged`). `onData`/`onEnded`/`onChanged`는 구독 해제 함수를 반환하는 이벤트 구독 패턴이다. preload를 고치면 이 파일을 함께 갱신해야 한다.

## 5. 주요 인터페이스 / 진입점

- `cn(...inputs: ClassValue[])` — Tailwind 클래스 조건부 병합. 프로젝트 표준.
- `formatTime(seconds: number): string` / `formatFileSize(bytes: number): string` / `downloadBlob(blob: Blob, filename: string): void`
- `findFrameIndex(times: number[], currentTime: number): number` — `ChartDetailOverlay`와 `lib/render/chart-window.ts`가 재생 위치 → 차트 프레임 매핑에 쓴다.
- `<Header />` — `DashboardClient.tsx`가 유일한 사용처.
- `<AnimatedSelect value options onChange placeholder? unit? disabled? />` + `SelectOption` 타입.
- `window.audioDevice?` / `window.audioCapture?` / `window.localFolder?` — Electron 전용 전역. 브라우저/모바일 빌드에서는 `undefined`이므로 feature-detect 필수. `audioDevice`/`audioCapture`의 `deviceUID` 인자는 생략 시 OS 기본 입력 장치를 대상으로 한다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
