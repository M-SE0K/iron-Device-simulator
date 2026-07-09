# calibration

## 1. 도메인 설명

분석 결과가 어떤 조건(스피커 모델·앰프 출력·주변온도·샘플레이트·버퍼·장치)에서 나온 값인지 앱 전체가 하나의 소스로 합의하게 만드는 도메인이다. 개발자는 이 폴더 하나만 보면 "사용자가 어디서 파라미터를 고치고, 그 값이 어떤 경로로 엔진·플레이어·차트에 도달하는지"를 파악할 수 있다.

기능 단위로는 세 가지다. 
(1) `CalibrationContext`가 캘리브레이션 파라미터 전체(`CalibrationValues`)를 앱 전역 단일 소스로 보관하고 sessionStorage에 유지한다. 
(2) `CalibrationDrawer`가 우측 슬라이딩 드로어에서 그 값을 편집한다 — 로컬 draft에서 고치고 "적용" 시 Context에 커밋하는 draft/commit 패턴이며 Electron에서는 커밋 직후 capture probe로 하드웨어 실제 반영값까지 확인한다. 
(3) `CalibrationSummary`가 현재 적용 상태를 파일 타이틀 옆 배지로 요약해 보여준다. 드로어의 편집 로직은 `hooks/` 5개(draft 관리, 적용/probe, 장치 옵션 자동 보정, 웹 장치 열거, 네이티브 장치 조회)로 분리되어 있고 `CalibrationDrawer`가 이들을 조합한다.

## 2. 프로젝트 전반에서의 역할

- `CalibrationProvider`는 `src/app/layout.tsx`에서 앱 전체를 감싼다. 즉 대시보드·플레이어·드로어가 모두 같은 `CalibrationValues` 인스턴스를 읽는다.
- `CalibrationDrawer`는 `src/shared/components/Header.tsx`가 렌더링한다(헤더 우측 트리거 버튼 포함). 드로어 안에서 대시보드의 입력 소스(파일/마이크)·분석 모드(실시간/배치) 토글도 함께 조작하는데, 이 상태는 `dashboard/AnalysisModeContext`를 통해 받는다(Provider 부재 시 해당 섹션 숨김).
- 커밋된 값의 소비처:
  - `dashboard/DashboardClient.tsx` — `speakerModel`/`ampOutputPower`/`ambientTemp`를 엔진 파라미터로, `tempWarn`/`tempDanger`를 이벤트 감지·차트 markLine 임계값으로 읽는다.
  - `player/WaveformPlayer.tsx` — `sampleRate`/`bufferSize`로 디코딩·프레이밍하고 `outputDeviceId`로 재생 출력을 라우팅한다(`WaveSurfer.setSinkId`).
  - `player/MicrophonePlayer.tsx` — `sampleRate`/`bufferSize`/`channels`/`captureDeviceUID`(네이티브 캡처) 또는 `inputDeviceId`/`inputDeviceLabel`(getUserMedia 폴백)으로 캡처를 연다.
  - `dashboard/SelectedFilePanel.tsx` — `CalibrationSummary` 배지를 두 곳에 표시한다.
- `sampleRate`/`bufferSize`는 라벨이 아니라 실제 엔진 런타임 설정이다(기본 48000 Hz / 480 samples/ch). 새 값은 다음 세션 시작(다음 재생/다음 캡처 시작)에 적용된다.
- `tempBase`/`excAmp`/`tempMult`/`excMult` 4개 프로파일 필드는 향후 `ff_prot_set_param` 연동을 위한 선행 필드로, 현재 엔진에 전달되지 않는다(`CalibrationContext.tsx` 상단 주석 기준).

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `CalibrationContext.tsx` | 앱 전역 단일 소스. `CalibrationValues` 인터페이스(15개 필드, 전부 string), 기본값 `CALIBRATION_EMPTY`, 옵션 상수(`SAMPLE_RATE_OPTIONS`/`BUFFER_SIZE_OPTIONS`/`CHANNEL_OPTIONS`), `CalibrationProvider`, `useCalibration()`을 export한다. 마운트 후 sessionStorage에서 복원하고(`hydrated` 가드로 기본값 덮어쓰기 방지), 값이 바뀔 때마다 저장한다. |
| `CalibrationDrawer.tsx` | 우측 슬라이딩 드로어(항상 마운트된 순수 DOM, `open` 불리언으로 클래스 토글). hooks/ 5개를 조합하고 로컬 UI 조각(`SelectField`, `NumberField`, `Segmented`, `DeviceRow`)으로 섹션(입력 소스/분석 모드, Input·Output Device, THRESHOLD, DEVICE, 연결된 장치)을 구성한다. 열릴 때마다 상태 리셋 + 장치 정보 새로고침을 하는 `[open]` 오케스트레이션 effect를 본체가 소유한다. Escape로 닫힘. |
| `CalibrationSummary.tsx` | 적용 상태 배지. `speakerModel !== ""`이면 "모델 · W · °C · Hz/버퍼" 요약을 파란색으로, 미선택이면 "모델 미선택 · 기본 프로파일로 분석"을 주황색으로 표시한다. |
| `DeviceSelectField.tsx` | Input/Output/Capture Device 3개 셀렉트가 공유하는 옵션 구성 컴포넌트. 플레이스홀더(`value=""`) 옵션을 앞에 붙이고 저장된 장치가 현재 목록에 없으면(연결 해제) "연결 안 됨" 힌트를 단 폴백 옵션으로 값을 보존한다. `headerRight`/`footnote` 슬롯 제공. |
| `hooks/useCalibrationDraft.ts` | 드로어 로컬 draft 상태. `open`이 true가 될 때마다 draft를 committed 값으로 동기화하고 부분 갱신 함수 `set(patch)`를 제공한다. |
| `hooks/useCalibrationApply.ts` | "적용" 오케스트레이션. `setValues(draft)`로 Context에 커밋 → 네이티브 브리지가 있으면 `window.audioCapture.start()`/`stop()` capture probe로 실제 SampleRate/BufferFrameSize를 읽고(TN2321: Buffer는 per-client라 probe로만 확인 가능) `DeviceActualCache`로 sessionStorage에 저장 → `refreshDeviceInfo()`로 패널 갱신. probe 시 채널 수를 `deviceInfo.inputChannels` 이하로 한 번 더 클램프한다. 브리지가 없으면 커밋 후 드로어를 바로 닫는다. |
| `hooks/useDeviceOptionAutoCorrect.ts` | 장치 능력(`query`) 도착 시 DEVICE 섹션 드롭다운 옵션을 그 장치의 지원값으로 재구성한다(SR: `supportedSampleRates`, Buffer: `bufferRange` 안의 정적 목록, Channels: `inputChannels` 이하). draft의 SR/Buffer/Channels가 지원 범위 밖이면 `nearestOption`으로 가장 가까운 지원값에 자동 보정하고 `adjustedNote` 안내 문구를 만든다. 조회 중에는 `deviceOptionsLoading`으로 선택을 잠근다. |
| `hooks/useMediaDevices.ts` | `navigator.mediaDevices.enumerateDevices()` 기반 입력(audioinput)/출력(audiooutput) 장치 열거 — 웹·Electron 공용. 마이크 권한이 없어 label이 전부 빈 문자열이면 `labelsHidden`을 세우고 `revealDeviceNames()`가 `getUserMedia`로 권한을 1회 얻어 트랙을 즉시 닫고 재열거한다. `devicechange` 이벤트로 자동 갱신. |
| `hooks/useNativeAudioDevice.ts` | `window.audioDevice`(Electron CoreAudio 헬퍼) 조회/열거. `hasAudioDeviceBridge` 감지(마운트 후 — 하이드레이션 불일치 방지), `refreshDeviceInfo(uid?)`(장치 능력 `query`: 현재값·지원 SR 목록·Buffer 범위·입력 채널 수), `refreshNativeDevices()`(`list`: UID(Unique Identifier)/이름/채널 수 목록). `DeviceInfo` 타입을 export하며 다른 두 훅이 이를 소비한다. |

## 4. 의존성 및 흐름

도메인 간 데이터 교환(방향 포함):

- **In (조회)** — `hooks/useNativeAudioDevice` → `window.audioDevice`(Electron IPC, 타입은 `shared/types/electron-bridge.d.ts`), `hooks/useMediaDevices` → `navigator.mediaDevices`. 둘 다 읽기 전용 데이터 페칭이라 실패해도 드롭다운/패널이 비어 보일 뿐 분석에는 영향이 없다.
- **In/Out (하드웨어 확인)** — `hooks/useCalibrationApply` → `window.audioCapture.start/stop`(capture probe) → 실제 반영값을 받아 `lib/cache/calibration.ts`(`saveDeviceActualCache`)에 저장.
- **Out (영속화)** — `CalibrationContext` → `lib/cache/calibration.ts`(`saveCalibrationCache`/`loadCalibrationCache`, sessionStorage, 탭 수명). 역으로 `lib/cache/calibration.ts`가 `CalibrationValues` 타입을 이 도메인에서 import하는 타입 순환이 있다(런타임 순환은 아니다).
- **Out (소비자)** — 커밋된 `values`를 `useCalibration()`으로 읽는 외부: `dashboard/DashboardClient`(엔진 파라미터·임계값), `player/WaveformPlayer`(디코딩 SR/버퍼·`setSinkId` 출력 라우팅), `player/MicrophonePlayer`(캡처 설정·장치 선택), `dashboard/SelectedFilePanel`(배지). Provider 마운트는 `app/layout.tsx`, 드로어 마운트는 `shared/components/Header`.
- **In (대시보드 상태)** — `CalibrationDrawer` ← `dashboard/AnalysisModeContext`(`useAnalysisMode()`, Provider 부재 시 null → 해당 섹션 숨김). 입력 소스/분석 모드 상태의 소유자는 여전히 `DashboardClient`다.
- **In (상수)** — `CalibrationContext` ← `lib/render/detect-events.ts`의 `DEFAULT_TEMP_WARN`(65°C)/`DEFAULT_TEMP_DANGER`(75°C)를 기본 임계값으로 사용. UI 컴포넌트는 `shared/components/AnimatedSelect`를 공용 셀렉트로 쓴다.

내부 처리 흐름 (드로어 열기 → 적용):

```
드로어 open
  → useCalibrationDraft: draft ← committed values 동기화
  → CalibrationDrawer [open] effect: resetStatus + clearAdjustedNote
      + refreshNativeDevices(list) + refreshDeviceInfo(query) + refreshInputDevices(enumerate)
  → useDeviceOptionAutoCorrect: query 결과로 옵션 재구성, 범위 밖 draft 값 자동 보정(adjustedNote)
사용자 편집 → set(patch) → draft만 갱신 (Context 불변)
"적용" → useCalibrationApply.apply()
  → setValues(draft)  ── Context 커밋 → sessionStorage 저장(CalibrationProvider effect)
  → (Electron) audioCapture.start → actual 확인 → stop → DeviceActualCache 저장
  → refreshDeviceInfo → "연결된 장치" 패널에 요청값→실제값 표시
```

## 5. 주요 인터페이스 / 진입점

- `CalibrationProvider({ children })` — 전역 Provider. `app/layout.tsx`에서 1회 마운트. sessionStorage 복원 완료(`hydrated`) 전에는 저장 effect가 돌지 않는다.
- `useCalibration(): { values: CalibrationValues; setValues: Dispatch<SetStateAction<CalibrationValues>> }` — 커밋된 값 읽기/쓰기. Provider 밖에서 호출하면 throw.
- `CalibrationValues` — 15개 필드 전부 string. 단위: `ampOutputPower` W, `ambientTemp`/`tempWarn`/`tempDanger` °C, `sampleRate` Hz, `bufferSize` samples/ch, `channels` 캡처 채널 수. `""`의 의미: `inputDeviceId`/`outputDeviceId`/`captureDeviceUID`는 시스템 기본 장치, `speakerModel`은 미선택(기본 프로파일).
- `CALIBRATION_EMPTY: CalibrationValues` — 기본값(48000 Hz / 480 / 2ch / 20 W / 25°C / WARN 65°C / DANGER 75°C). 드로어 "초기화" 버튼이 draft에 그대로 대입한다.
- `SAMPLE_RATE_OPTIONS` / `BUFFER_SIZE_OPTIONS` / `CHANNEL_OPTIONS: string[]` — 장치 능력 조회가 없을 때(브라우저)의 데모 옵션 목록. Electron에서는 `useDeviceOptionAutoCorrect`가 장치 지원값으로 대체/필터링한다.
- `CalibrationDrawer({ projectName?, onApply? })` (default export) — 트리거 버튼 + 드로어 본체. `onApply(values)`는 커밋 직후 호출되는 선택 콜백.
- `CalibrationSummary({ className? })` (default export) — 적용 상태 배지. props 외 입력은 전역 Context.
- `DeviceSelectField(props)` (default export) — 장치 셀렉트 공용 컴포넌트. `devices`에 없는 `value`를 `savedLabel` + "연결 안 됨" 힌트로 보존 표시한다.
- `useCalibrationApply(deps): { deviceStatus, deviceActual, deviceError, appliedRuntime, apply, resetStatus }` — `deviceStatus`는 `"idle" | "applying" | "applied" | "error"`. probe는 마이크가 이미 녹음 중이면 `capture-already-running`으로 실패한다.
- `useCalibrationDraft(open, values): { draft, setDraft, set }` — `set`은 `Partial<CalibrationValues>` 병합.
- `useDeviceOptionAutoCorrect(deps): { sampleRateOptions, bufferSizeOptions, channelOptions, deviceOptionsLoading, adjustedNote, clearAdjustedNote }` — 보정은 `deviceInfo` 변경 시점에만 실행되어 루프가 나지 않는다.
- `useMediaDevices(): { hasMediaDevices, inputDevices, outputDevices, devicesLoading, labelsHidden, refreshInputDevices, revealDeviceNames }`
- `useNativeAudioDevice(captureDeviceUID): { hasAudioDeviceBridge, deviceInfo, deviceInfoLoading, refreshDeviceInfo, nativeDevices, nativeDevicesLoading, refreshNativeDevices }` — `refreshDeviceInfo(uid?)`에서 uid 생략 시 인자로 받은 `captureDeviceUID`(그마저 없으면 OS 기본 입력)를 조회한다. `DeviceInfo` 타입도 여기서 export.

주의사항:

- BufferFrameSize는 per-client 속성(TN2321)이다. `query`는 장치 기본값만 돌려주며 실제 반영값은 "적용"의 capture probe 결과(`deviceActual`/`appliedRuntime`)로만 확인한다.
- 입력 장치 선택기는 빌드별로 분리된다. Electron에서는 Capture Device(`captureDeviceUID`, CoreAudio UID)만 노출하고 브라우저 Input Device(`inputDeviceId`, MediaDevices deviceId)를 숨긴다. Output Device는 양쪽 모두 노출한다(`setSinkId`는 표준 웹 API).
- `sampleRate`/`bufferSize` 변경은 진행 중인 세션에 반영되지 않는다 — 다음 재생/다음 캡처 시작부터 적용된다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
