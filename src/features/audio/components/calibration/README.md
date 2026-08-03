# calibration

## 1. 도메인 설명

이 도메인은 분석 결과가 어떤 조건에서 나온 값인지를 앱 전체가 하나의 소스로 합의하게 만든다. 조건은 스피커 모델·앰프 출력·주변온도·샘플레이트·버퍼·장치다. 개발자는 이 폴더만 보고도 사용자가 어디서 파라미터를 고치는지, 그 값이 어떤 경로로 엔진·플레이어·차트에 도달하는지 파악한다.

기능 단위로는 두 가지다. 하나는 `CalibrationContext`가 캘리브레이션 파라미터 전체(`CalibrationValues`)를 앱 전역 단일 소스로 들고 sessionStorage에 저장하는 일, 다른 하나는 `CalibrationDrawer`가 우측 슬라이딩 드로어에서 그 값을 편집하는 일이다.

드로어는 로컬 draft에서 고친 뒤 "적용"할 때 Context에 커밋하는 draft/commit 패턴을 쓴다. 네이티브 브리지(Tauri)가 있으면 커밋 직후 capture probe로 하드웨어에 실제 반영된 값까지 확인한다. 편집 로직은 `hooks/` 4개(draft 관리, 적용/probe, 장치 옵션 자동 보정, 네이티브 장치 조회)로 나뉘고 `CalibrationDrawer`가 이들을 조합한다.

## 2. 프로젝트 전반에서의 역할

- `CalibrationProvider`는 `src/app/layout.tsx`에서 앱 전체를 감싼다. 덕분에 대시보드·플레이어·드로어가 모두 같은 `CalibrationValues` 인스턴스를 읽는다.
- `CalibrationDrawer`를 마운트하는 쪽은 `dashboard/DashboardClient.tsx`고, 여닫는 트리거 버튼은 `shared/components/Sidebar.tsx`에 있다. 열림 여부는 `dashboard/ActiveDrawerContext`(`active === "calibration"`)에서 파생한다. 입력 소스(파일/마이크) 토글은 이 드로어에서 대시보드 상단 세그먼트 컨트롤로 옮겨갔다. 분석 모드(실시간/배치)는 개념 자체가 제거됐다.
- 커밋된 값의 소비처:
  - `dashboard/DashboardClient.tsx` — `speakerModel`/`ampOutputPower`/`ambientTemp`를 엔진 파라미터로, `tempWarn`/`tempDanger`를 이벤트 감지·차트 markLine 임계값으로 읽는다.
  - `player/DuplexFilePlayer.tsx`, `player/capture/useCaptureSession.ts` — `sampleRate`/`bufferSize`/`channels`/`captureDeviceUID`로 네이티브 캡처 세션(V/I)을 연다. 업로드 파일 자체를 디코딩해 분석하지는 않는다(파일은 재생용 참조 PCM으로만 쓰인다).
- `sampleRate`/`bufferSize`는 라벨이 아니라 실제 엔진 런타임 설정이다(기본값은 `lib/engine/core.ts`의 `SAMPLE_RATE`/`SAMPLES_PER_CH` 단일 소스에서 가져온다 — 48000 Hz / 480 samples/ch). 새 값은 다음 세션 시작(다음 재생/다음 캡처 시작)부터 적용된다.
- `tempBase`/`excAmp`/`tempMult`/`excMult` 4개 프로파일 필드는 향후 `ff_prot_set_param` 연동을 위한 선행 필드로, 현재 엔진에 전달되지 않는다(`CalibrationContext.tsx` 상단 주석 기준).
- 앱이 Tauri 데스크톱 단일 셸로 좁혀지면서(플레인 브라우저 빌드 경로 제거) 브라우저 `navigator.mediaDevices` 기반 Input/Output Device 선택 UI는 드로어에서 완전히 빠졌다. 지금은 `hasAudioDeviceBridge`(네이티브 브리지 존재)가 있을 때만 장치 관련 섹션을 그린다. 파일 재생은 Capture Device의 출력 ch0/ch1로 직접 나가는 구조(play-capture 단일 IOProc)라 Output Device라는 개념 자체가 없다. `outputChannel` 필드는 `CalibrationValues`에 "0" 고정으로 남아 있지만 이를 고르는 UI는 없다. R 채널은 항상 `outputChannel + 1`로 파생되며, 그 장치 출력이 1채널뿐이면 재생 쪽에서 모노로 조용히 폴백한다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `CalibrationContext.tsx` | 앱 전역 단일 소스. `CalibrationProvider`, `useCalibration()`만 정의하고, 옵션 상수(`SAMPLE_RATE_OPTIONS`/`BUFFER_SIZE_OPTIONS`/`CHANNEL_OPTIONS`/`CALIBRATION_EMPTY`)는 `calibration-options.ts`에서 그대로 재export한다. `CalibrationValues` 인터페이스(16개 필드, 전부 string) 자체는 `features/audio/types.ts`로 옮겨 이 파일은 그 타입을 import만 한다(다른 도메인이 Context를 거치지 않고도 타입을 참조할 수 있도록 단일 소스화). 마운트 후 sessionStorage에서 복원하고(`hydrated` 가드로 기본값 덮어쓰기 방지), 값이 바뀔 때마다 저장한다. |
| `calibration-options.ts` | 캘리브레이션 옵션 상수와 기본값을 모은 leaf 모듈. `SAMPLE_RATE_OPTIONS`/`BUFFER_SIZE_OPTIONS`/`CHANNEL_OPTIONS`, `CALIBRATION_EMPTY`(기본값 — `ambientTemp`/`sampleRate`/`bufferSize`/`tempWarn`/`tempDanger`는 `lib/engine/core.ts`·`lib/render/detect-events.ts`의 단일 소스 상수를 그대로 문자열화). `CalibrationContext.tsx`가 이 파일에서 import해 재export한다. |
| `CalibrationDrawer.tsx` | 우측 슬라이딩 드로어. 셸(백드롭·패널·헤더·푸터)은 공용 `shared/components/overlay/SideDrawer`(커스텀 헤더/푸터 슬롯)에 위임하고, `open`은 `useActiveDrawer().active === "calibration"`에서 파생한다. hooks/ 4개를 조합하고 로컬 UI 조각(`SelectField`/`NumberField`는 공용 `shared/components/ui/LabeledField` 기반, `DeviceRow`)으로 섹션(THRESHOLD, DEVICE, 연결된 장치)을 구성한다 — 웹 전용 Input/Output Device 섹션은 없고, DEVICE·연결된 장치 섹션 모두 `hasAudioDeviceBridge`(네이티브 브리지)가 있을 때만 그려진다. 헤더에는 닫기 버튼만 두고 제목·트리거는 없다(트리거는 Sidebar 담당). 텍스트는 전부 `useLocale()`의 `t.calibration.*`를 통해 표시된다. 드롭다운은 `shared/components/ui/AnimatedSelect`를 쓴다. 열릴 때마다 상태 리셋 + 장치 정보 새로고침을 하는 `[open]` 오케스트레이션 effect를 본체가 소유한다. ESC 닫기는 `useEscapeKey`. |
| `DeviceSelectField.tsx` | Capture Device 셀렉트가 쓰는 옵션 구성 컴포넌트. 플레이스홀더(`value=""`) 옵션을 앞에 붙이고 저장된 장치가 현재 목록에 없으면(연결 해제) "연결 안 됨" 힌트를 단 폴백 옵션으로 값을 보존한다. 라벨+컨트롤 레이아웃은 공용 `LabeledField`에 위임하고 `headerRight`/`footnote` 슬롯을 넘긴다. |
| `hooks/useCalibrationDraft.ts` | 드로어 로컬 draft 상태. `open`이 true가 될 때마다 draft를 committed 값으로 동기화하고 부분 갱신 함수 `set(patch)`를 제공한다. |
| `hooks/useCalibrationApply.ts` | "적용" 오케스트레이션. `setValues(draft)`로 Context에 커밋 → 네이티브 브리지가 있으면 `window.audioCapture.start()`/`stop()` capture probe로 실제 SampleRate/BufferFrameSize/Channels를 읽고(TN2321: Buffer는 per-client라 probe로만 확인 가능) `DeviceActualCache`로 sessionStorage에 저장 → `refreshDeviceInfo()`로 패널 갱신. probe 시 채널 수를 `deviceInfo.inputChannels` 이하로 한 번 더 클램프한다. probe 응답의 채널 수(`result.channels`)는 `actual`과 형제 필드로 오므로 합쳐서(`actualWithChannels`) 저장·표시한다. 브리지가 없으면 커밋 후 드로어를 바로 닫는다. 성공/실패 메시지는 이제 로컬 배너가 아니라 `shared/components/error-popup`의 전역 `useErrorPopup()`(`showSuccess`/`showError`)로 띄우고, 문구는 `useLocale()`의 `t.calibration.*`에서 가져온다. |
| `hooks/useDeviceOptionAutoCorrect.ts` | 장치 능력(`query`) 도착 시 DEVICE 섹션 드롭다운 옵션을 그 장치의 지원값으로 재구성한다(SR: `supportedSampleRates`, Buffer: `bufferRange` 안의 정적 목록, Channels: `inputChannels` 이하). draft의 SR/Buffer/Channels가 지원 범위 밖이면 `nearestOption`으로 가장 가까운 지원값에 자동 보정하고 `adjustedNote` 안내 문구(`useLocale()`의 `t.calibration.*Change`)를 만든다. 조회 중에는 `deviceOptionsLoading`으로 선택을 잠근다. Output Channel 옵션 재구성 로직은 더 이상 없다(아래 2번 섹션 참고 — UI 자체가 빠졌다). |
| `hooks/useNativeAudioDevice.ts` | `window.audioDevice`(네이티브 오디오 헬퍼) 조회/열거. `hasAudioDeviceBridge` 감지(마운트 후 — 하이드레이션 불일치 방지), `refreshDeviceInfo(uid?)`(장치 능력 `query`: 현재값·지원 SR 목록·Buffer 범위·입력 채널 수·출력 채널 수), `refreshNativeDevices()`(`list`: UID(Unique Identifier)/이름/채널 수 목록). `DeviceInfo` 타입을 export하며 다른 두 훅이 이를 소비한다. 타입은 `shared/types/native-bridge`에서 가져온다. `outputChannels`가 0이면 그 장치는 입력 전용이라 play-capture(파일 재생)를 할 수 없다는 뜻이다. |

## 4. 의존성 및 흐름

도메인 간 데이터 교환(방향 포함):

- **In (조회)** — `hooks/useNativeAudioDevice` → `window.audioDevice`(Tauri IPC, 타입은 `shared/types/native-bridge.d.ts`). 읽기 전용 데이터 페칭이라 실패해도 드롭다운/패널이 비어 보일 뿐 분석에는 영향이 없다. 브라우저 `navigator.mediaDevices` 기반 열거(구 `hooks/useMediaDevices.ts`)는 플레인 브라우저 빌드 경로가 없어져 삭제됐다.
- **In/Out (하드웨어 확인)** — `hooks/useCalibrationApply` → `window.audioCapture.start/stop`(capture probe) → 실제 반영값을 받아 `lib/cache/calibration.ts`(`saveDeviceActualCache`)에 저장.
- **Out (영속화)** — `CalibrationContext` → `lib/cache/calibration.ts`(`saveCalibrationCache`/`loadCalibrationCache`, sessionStorage, 탭 수명). `CalibrationValues` 타입의 단일 소스는 이 도메인이 아니라 `features/audio/types.ts`다. 그래서 `CalibrationContext`와 `lib/cache/calibration.ts` 둘 다 거기서 import한다. 과거엔 이 도메인이 타입을 정의해 `lib/cache/calibration.ts`와 역참조 순환이 있었지만 types.ts로 옮기면서 풀렸다.
- **In (타입)** — `CalibrationContext`/`CalibrationDrawer`/`useCalibrationDraft` ← `features/audio/types.ts`의 `CalibrationValues`(단일 소스). `ambientTemp`/`sampleRate`/`bufferSize`/`tempWarn`/`tempDanger` 기본값은 `calibration-options.ts`가 `lib/engine/core.ts`의 `DEFAULT_AMBIENT_TEMP`/`SAMPLE_RATE`/`SAMPLES_PER_CH`와 `lib/render/detect-events.ts`의 `DEFAULT_TEMP_WARN`/`DEFAULT_TEMP_DANGER`를 가져다 쓴다.
- **Out (소비자)** — 커밋된 `values`를 `useCalibration()`으로 읽는 외부: `dashboard/DashboardClient`(엔진 파라미터·임계값), `player/DuplexFilePlayer`·`player/capture/useCaptureSession`(캡처 세션 SR/버퍼/채널/장치 UID). Provider 마운트는 `app/layout.tsx`, 드로어 마운트는 `dashboard/DashboardClient`(트리거는 `shared/components/Sidebar`).
- **In (드로어 개폐)** — `CalibrationDrawer` ← `dashboard/ActiveDrawerContext`(`useActiveDrawer()`). `active === "calibration"`일 때만 열린다. 여닫는 트리거는 `Sidebar`다.
- **In (에러/성공 피드백, i18n)** — `hooks/useCalibrationApply` ← `shared/components/error-popup`의 `useErrorPopup()`, `CalibrationDrawer`/`useCalibrationApply`/`useDeviceOptionAutoCorrect` ← `shared/lib/i18n/LocaleProvider`의 `useLocale()`. 이전에는 이 도메인이 자체 배너와 하드코딩 문자열로 처리했는데, 그 몫을 `shared/`의 전역 인프라로 넘겼다.
- **In (공용 UI 부품)** — 드롭다운은 `shared/components/ui/AnimatedSelect`, 라벨+컨트롤 레이아웃은 `shared/components/ui/LabeledField`(`SelectField`/`NumberField`/`DeviceSelectField` 공용), 드로어 셸은 `shared/components/overlay/SideDrawer`, ESC 닫기는 `shared/hooks/useEscapeKey`에 위임한다.

내부 처리 흐름 (드로어 열기 → 적용):

```
드로어 open
  → useCalibrationDraft: draft ← committed values 동기화
  → CalibrationDrawer [open] effect: resetStatus + clearAdjustedNote
      + refreshNativeDevices(list) + refreshDeviceInfo(query)
  → useDeviceOptionAutoCorrect: query 결과로 옵션 재구성, 범위 밖 draft 값 자동 보정(adjustedNote)
사용자 편집 → set(patch) → draft만 갱신 (Context 불변)
"적용" → useCalibrationApply.apply()
  → setValues(draft)  ── Context 커밋 → sessionStorage 저장(CalibrationProvider effect)
  → (네이티브 브리지가 있으면) audioCapture.start → actual 확인 → stop → DeviceActualCache 저장
  → refreshDeviceInfo → "연결된 장치" 패널에 요청값→실제값 표시
```

## 5. 주요 인터페이스 / 진입점

- `CalibrationProvider({ children })` — 전역 Provider. `app/layout.tsx`에서 1회 마운트. sessionStorage 복원 완료(`hydrated`) 전에는 저장 effect가 돌지 않는다.
- `useCalibration(): { values: CalibrationValues; setValues: Dispatch<SetStateAction<CalibrationValues>> }` — 커밋된 값 읽기/쓰기. Provider 밖에서 호출하면 throw.
- `CalibrationValues`(`features/audio/types.ts`) — 16개 필드 전부 string. 단위: `ampOutputPower` W, `ambientTemp`/`tempWarn`/`tempDanger` °C, `sampleRate` Hz, `bufferSize` samples/ch, `channels` 캡처 채널 수, `outputChannel` 재생 출력 채널 인덱스(네이티브 전용, "0"=ch0). `""`의 의미: `inputDeviceId`/`outputDeviceId`/`captureDeviceUID`는 시스템 기본 장치, `speakerModel`은 미선택(기본 프로파일).
- `CALIBRATION_EMPTY: CalibrationValues`(`calibration-options.ts`, `CalibrationContext.tsx`가 재export) — 기본값(48000 Hz / 480 / 2ch / Output Channel "0" / 20 W / 25°C / WARN 65°C / DANGER 75°C). 드로어 "초기화" 버튼이 draft에 그대로 대입한다.
- `SAMPLE_RATE_OPTIONS` / `BUFFER_SIZE_OPTIONS` / `CHANNEL_OPTIONS: string[]`(`calibration-options.ts`, `CalibrationContext.tsx`가 재export) — 장치 능력 조회가 없을 때의 데모 옵션 목록. `useDeviceOptionAutoCorrect`가 실제 장치가 있으면 지원값으로 대체·필터링한다.
- `CalibrationDrawer({ projectName?, onApply? })` (default export) — 드로어 본체(트리거는 Sidebar가 담당). `onApply(values)`는 커밋 직후 호출되는 선택 콜백.
- `DeviceSelectField(props)` (default export) — 장치 셀렉트 공용 컴포넌트. `devices`에 없는 `value`를 `savedLabel` + "연결 안 됨" 힌트로 보존 표시한다.
- `useCalibrationApply(deps): { deviceStatus, deviceActual, deviceError, appliedRuntime, apply, resetStatus }` — `deviceStatus`는 `"idle" | "applying" | "applied" | "error"`. probe는 마이크가 이미 녹음 중이면 `capture-already-running`으로 실패한다. `deviceActual`/`appliedRuntime.actual`은 `channels` 필드를 포함한다(probe 응답의 형제 필드를 합친 값). 성공/실패는 `useErrorPopup()`의 전역 팝업으로도 표시되므로, `deviceError`는 드로어 자체 UI에는 더 이상 렌더되지 않고 내부 상태 추적용으로만 쓰인다.
- `useCalibrationDraft(open, values): { draft, setDraft, set }` — `set`은 `Partial<CalibrationValues>` 병합.
- `useDeviceOptionAutoCorrect(deps): { sampleRateOptions, bufferSizeOptions, channelOptions, deviceOptionsLoading, adjustedNote, clearAdjustedNote }` — 보정은 `deviceInfo` 변경 시점에만 실행되어 루프가 나지 않는다. Output Channel 옵션은 더 이상 다루지 않는다(아래 주의사항 참고).
- `useNativeAudioDevice(captureDeviceUID): { hasAudioDeviceBridge, deviceInfo, deviceInfoLoading, refreshDeviceInfo, nativeDevices, nativeDevicesLoading, refreshNativeDevices }` — `refreshDeviceInfo(uid?)`에서 uid 생략 시 인자로 받은 `captureDeviceUID`(그마저 없으면 OS 기본 입력)를 조회한다. `DeviceInfo`(`outputChannels` 포함) 타입도 여기서 export.

주의사항:

- BufferFrameSize는 per-client 속성(TN2321)이다. `query`는 장치 기본값만 돌려주며 실제 반영값은 "적용"의 capture probe 결과(`deviceActual`/`appliedRuntime`)로만 확인한다.
- 플레인 브라우저 빌드 경로가 사라지면서 입력/출력 장치 선택기는 이제 네이티브 하나뿐이다 — Capture Device(`captureDeviceUID`, `hasAudioDeviceBridge`가 있을 때만 노출)만 남고 과거의 브라우저 Input/Output Device 선택기는 완전히 제거됐다. Output Channel(`outputChannel`)을 고르는 UI도 없다 — 값은 `CalibrationValues`에 `"0"`으로 남아 있지만 드로어에서 편집할 수 없다. R 채널은 재생 쪽에서 `outputChannel + 1`로 고정 파생된다(그 채널이 없으면 모노로 폴백).
- `sampleRate`/`bufferSize` 변경은 진행 중인 세션에 반영되지 않는다 — 다음 재생/다음 캡처 시작부터 적용된다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: 드로어 개폐 경로 변경 반영 — `Header` 삭제로 마운트는 `DashboardClient`, 트리거는 `Sidebar`+`ActiveDrawerContext`로 이동. `AnalysisModeContext` 소비 제거(입력 소스 토글은 대시보드 상단으로 이동, 분석 모드 제거)에 따라 드로어의 입력 소스/분석 모드 섹션 삭제. `WaveformPlayer` 소비 설명을 파일 디코딩 → 캡처 세션으로 정정. 섹션 2·3·4·5 부분 갱신 (커밋 범위: e0add14..HEAD, 워크트리 포함)
- 2026-07-10: 공용 UI 부품 위임 반영 — `CalibrationDrawer` 셸을 `shared/components/overlay/SideDrawer`(커스텀 헤더/푸터 슬롯), ESC 닫기를 `hooks/useEscapeKey`로 위임. `SelectField`/`NumberField`/`DeviceSelectField`의 라벨+컨트롤 레이아웃을 공용 `shared/components/ui/LabeledField`로 통합. `AnimatedSelect` 경로는 `shared/components/ui/AnimatedSelect`로 이동. 섹션 3·4 부분 갱신 (커밋 범위: 537099f..HEAD, 워크트리 포함)
- 2026-07-13: `CalibrationSummary.tsx` 삭제 반영 — 적용 상태 배지 컴포넌트를 제거(`SelectedFilePanel`이 더는 렌더하지 않음). `CalibrationDrawer`가 `AnimatedSelect`/`SideDrawer`/`LabeledField`를 `shared/components/ui`·`overlay` 경로에서 import하도록 정리하고, 드로어 헤더의 "Calibration Parameter" 제목을 제거해 닫기 버튼만 남겼다. 섹션 1·2·3·5 부분 갱신 (커밋 범위: 9f08d59..HEAD, 워크트리 포함)
- 2026-07-20: `CalibrationValues` 타입을 `features/audio/types.ts`로 이관(단일 소스화, 이전엔 이 도메인이 정의)하고 `sampleRate`/`bufferSize`/`ambientTemp` 기본값도 `lib/engine/core.ts` 상수로 통일. `outputChannel` 필드 신규 추가 — Electron 파일 재생(play-capture)이 낼 출력 채널을 고르는 Output Channel 셀렉트가 생겼고, 그 대신 Electron에서는 Output Device 필드를 아예 숨긴다(웹 전용으로 축소). `DeviceInfo`에 `outputChannels` 추가로 "연결된 장치" 패널이 출력 채널 수와 0채널 경고를 보여준다. `useCalibrationApply`가 probe 응답의 채널 수까지 합쳐 저장. 섹션 2·3·4·5 부분 갱신 (커밋 범위: 14af466..fb8e4fa)
- 2026-07-30: Electron 제거 + Tauri 단일 셸 전환 반영. 플레인 브라우저 빌드 경로가 없어져 `hooks/useMediaDevices.ts`(브라우저 `navigator.mediaDevices` 열거)와 드로어의 웹 전용 Input/Output Device 섹션을 모두 지웠다. Output Channel 선택 UI도 빠졌다(`outputChannel` 값 자체는 `"0"` 고정으로 남음). 옵션 상수·기본값은 `CalibrationContext.tsx`에서 신규 `calibration-options.ts`로 떼어냈다. `useCalibrationApply`/`CalibrationDrawer`는 `shared/components/error-popup`(전역 에러/성공 팝업)와 `shared/lib/i18n`(`useLocale`)에 새로 의존한다. `useNativeAudioDevice`의 타입 참조 경로는 `electron-bridge.d.ts` → `native-bridge.d.ts`로 바뀌었다. 소비처 설명도 삭제된 `player/WaveformPlayer.tsx`/`player/MicrophonePlayer.tsx`에서 현재의 `player/DuplexFilePlayer.tsx`/`player/capture/useCaptureSession.ts`로 정정. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: 14941b7..HEAD, 작업 트리의 커밋되지 않은 변경 포함)
