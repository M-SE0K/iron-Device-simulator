# electron/ipc

## 1. 도메인 설명

렌더러(`preload.js`가 노출한 `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`)의 호출을 받아 실제 네이티브 헬퍼 프로세스를 실행하거나 파일시스템에 접근하는 Electron 메인 프로세스 쪽 IPC 핸들러 모음이다. 이 폴더만 훑어도 "렌더러가 부른 IPC 채널 하나가 어떤 자식 프로세스 명령으로 바뀌고, 그 결과(JSON 헤더 + 스트리밍 PCM, 또는 파일 데이터)가 어떤 채널로 되돌아가는지" 흐름이 한눈에 잡힌다.

파일 5개로 나뉜다. `audio-device.js`는 헬퍼 바이너리 경로 해석과 1회성 명령(list/get/query/set) 실행을, `audio-capture.js`는 상주 `capture` 모드(마이크 캡처)를 맡는다. `audio-playcapture.js`는 상주 `play-capture` 모드(파일 재생+캡처 단일 IOProc)까지 담당한다. `local-folder.js`는 네이티브 헬퍼와 무관하게 Node `fs`만으로 로컬 폴더 선택·감시·읽기를 처리한다. `run-streaming-helper.js`는 `audio-capture.js`/`audio-playcapture.js`가 공유하는 "헬퍼 자식 프로세스를 spawn하고 첫 줄 JSON 헤더 이후의 stdout을 렌더러로 중계하는" 공용 로직이다. 각 파일은 `require`되는 순간 자신의 `ipcMain.handle` 채널을 등록하는 부수효과를 가진다 — `electron/main.js`가 이 파일들을 불러오는 것 자체가 등록 트리거다.

## 2. 프로젝트 전반에서의 역할

이 도메인은 `electron/` 루트(`main.js`/`preload.js`)와 macOS 네이티브 헬퍼(`electron/native/macos/audio-device-helper`) 사이를 잇는 중간 계층이다. 헬퍼 프로세스 자체의 오디오 처리 로직은 갖지 않고, spawn·stdout 파싱·IPC 중계·리소스 정리만 맡는다.

- 캡처 경로(`audio-capture.js`, `audio-playcapture.js`)는 헬퍼가 stdout에 첫 줄 JSON 헤더 한 번, 그 뒤로 int16 인터리브 raw PCM 청크를 계속 흘려보내는 동일한 스트리밍 프로토콜을 쓴다 — 이 공통 처리를 `run-streaming-helper.js`가 흡수해 두 파일이 각자 spawn/stdout 파싱 코드를 중복 구현하지 않는다.
- `audio-device.js`가 export하는 `AUDIO_HELPER_PATH`/`SUPPORTED_PLATFORMS`/`withDevice`는 헬퍼 바이너리 경로 해석과 플랫폼 판정을 3개 IPC 모듈이 공유하는 단일 소스다. macOS는 `native/macos/audio-device-helper/dist/`, Windows는 `native/windows/audio-device-helper/dist/`(아직 소스 없음, `docs/windows-plan.md` 계획 단계) 경로 규칙만 다르고 CLI 인자 계약은 동일하다는 전제로 짜여 있다.
- `audio-playcapture.js`의 청크 핸드셰이크(start-write/write-chunk/finalize-write)는 렌더러가 디코드한 재생 참조 PCM(수 분 파일 기준 수십 MB)을 한 번의 IPC로 넘기면 Electron 메인 프로세스(싱글스레드)가 그 순간 멎는 문제를 피하려고 존재한다 — IPC 계층에서만 필요한 우회이지, 재생/캡처 자체의 로직은 아니다.
- `local-folder.js`는 `select()`로 마지막에 고른 폴더 경로(`allowedFolderPath`) 밖의 파일 읽기를 거부해(`local-folder:read-file`) 렌더러가 임의 경로를 읽을 수 없게 막는다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `audio-device.js` | 헬퍼 바이너리 경로 해석(`AUDIO_HELPER_PATH`는 패키징 시 `process.resourcesPath`, dev는 `native/<macos\|windows>/audio-device-helper/dist/`)과 플랫폼 지원 판정(`SUPPORTED_PLATFORMS = ["darwin", "win32"]`, Windows는 바이너리가 아직 없어 실제 실행 시 ENOENT). `runAudioHelper(args)`가 `execFile`로 헬퍼를 1회 실행하고 stdout을 JSON으로 파싱해 반환한다. `withDevice(baseArgs, deviceUID)`는 UID가 있으면 `--device <UID>`를 붙이고 없으면 OS 기본 입력을 대상으로 한다. `audio-device:list/get-config/set-config/query` 4개 채널을 등록하고, `AUDIO_HELPER_PATH`/`SUPPORTED_PLATFORMS`/`withDevice`를 다른 두 IPC 모듈이 재사용하도록 export한다. |
| `audio-capture.js` | 상주 `capture` 모드(마이크 캡처, IOProc이 직접 BufferFrameSize를 열어 요청값이 실제 적용됨, TN2321). `audio-capture:start`가 `runStreamingHelper()`로 헬퍼를 spawn하고(이미 실행 중이면 `capture-already-running` 즉시 반환), `stopCapture()`가 자식을 `SIGTERM`으로 종료한다(먼저 참조를 비워 exit 핸들러의 "ended" 이벤트 전송을 억제 — 사용자 주도 종료와 헬퍼 자연 종료를 구분). `stopCapture`를 export해 `main.js`가 앱 종료 시 호출한다. |
| `audio-playcapture.js` | 상주 `play-capture` 모드(파일 재생 + 캡처를 같은 IOProc의 출력 ch0/`--out-ch`로, 단일 클록). 재생 참조 PCM은 `start-write`→`write-chunk`(반복, 내부 스트림 `drain` 대기로 백프레셔)→`finalize-write` 청크 핸드셰이크로 임시 `.f32` 파일에 쓴 뒤(`os.tmpdir()`), 그 `writeId`를 `audio-playcapture:start`의 `refWriteId`로 소비해 헬퍼에 `--ref <path>`로 넘긴다. `opts.outputChannel`이 있으면(Calibration의 Output Channel 필드, `useCaptureSession`이 `calibration.outputChannel`을 그대로 실어 보냄) `--out-ch`를 추가한다. `control(action)`은 "pause"/"resume" 문자열을 헬퍼 stdin에 그대로 써서 중계한다(재생 위치 동결/재개, 캡처는 계속). 헬퍼가 재생 완료(+감쇠 테일) 시 스스로 `exit 0`하면 `ended {code:0}`으로, 그 외 코드는 비정상 종료로 렌더러에 전달된다. 임시 ref 파일은 헬퍼 종료(`onChildExit`)/에러(`onChildError`) 어느 경로든 정리(`cleanupRef`)한다. `stopPlayCapture`를 export한다. |
| `local-folder.js` | 로컬 폴더 연결(워크스페이스 "로컬 폴더"). `local-folder:select`가 `dialog.showOpenDialog`로 폴더를 고르고 `scanAudioFolder()`(확장자 화이트리스트 `.wav/.mp3/.m4a/.flac/.ogg/.aac/.wma`)로 오디오 파일만 나열한 뒤 `fs.watch`로 감시를 건다(250ms 디바운스, 변경마다 재스캔해 `local-folder:changed` 이벤트로 push). `local-folder:read-file`은 `allowedFolderPath`(마지막 select 결과) 하위 경로인지 `path.resolve` 비교로 검증한 뒤에만 읽어 임의 경로 접근을 막는다. `stopWatchingFolder`를 export한다. |
| `run-streaming-helper.js` | `audio-capture.js`/`audio-playcapture.js`가 공유하는 스트리밍 헬퍼 실행 공통 로직. `spawn(helperPath, args)` 후 stdout의 첫 줄(개행 전까지)을 JSON 헤더로 파싱해 `settle()`로 최초 IPC 응답을 확정하고, 그 이후(헤더에 이어붙은 나머지 바이트 포함) 청크는 `dataChannel`로 렌더러에 중계한다. 헤더가 `success: false`면 `stopActiveChild()`를 호출해 자식을 바로 정리한다. 자식의 `error`/`exit` 이벤트에서 `onChildError`/`onChildExit` 콜백을 호출하고(`isCurrentChild(child)`로 이미 교체된 자식이 아닌지 확인 후) `setChild(null)` + `endedChannel` 이벤트를 보낸다. `runStreamingHelper(opts)` 하나만 export한다. |

## 4. 의존성 및 흐름

**이 도메인이 import하는 것** (안쪽 방향):

- `audio-capture.js`, `audio-playcapture.js` → `./audio-device`(`AUDIO_HELPER_PATH`/`SUPPORTED_PLATFORMS`/`withDevice`), `./run-streaming-helper`(`runStreamingHelper`).
- 외부 패키지/Node 내장 — `electron`(`app`/`ipcMain`/`BrowserWindow`/`dialog`), `child_process`(`execFile`/`spawn`), `fs`/`path`/`os`.
- 헬퍼 바이너리 자체 — `electron/native/macos/audio-device-helper/dist/audio-device-helper`(Windows는 `electron/native/windows/audio-device-helper/`, 아직 소스 없음). 코드로 import하지 않고 `execFile`/`spawn`이 경로 문자열로 실행한다.

**이 도메인을 import하는 것** (바깥 방향):

- `electron/main.js` → 5개 파일 전부를 `require`해 채널을 등록시키고(`audio-device.js`는 등록 부수효과만 사용), `audio-capture.js`(`stopCapture`)·`audio-playcapture.js`(`stopPlayCapture`)·`local-folder.js`(`stopWatchingFolder`)의 정지 함수를 앱 종료 라이프사이클에서 호출한다.
- 렌더러 — 직접 import하지 않는다. `electron/preload.js`가 노출한 `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`를 통해 `ipcRenderer.invoke(channel, ...)`로만 이 도메인의 핸들러에 닿는다.

**내부 처리 흐름** (스트리밍 캡처 공통 — `audio-capture:start`/`audio-playcapture:start` 동일 패턴):

```
렌더러 invoke("audio-*:start", opts)
  → withDevice(args, deviceUID)               # audio-device.js
  → runStreamingHelper({ helperPath, args, ... })  # run-streaming-helper.js
      → spawn(helperPath, args)
      → stdout 첫 줄 = JSON 헤더 → settle(header)로 invoke 응답 확정
      → 이후 stdout 청크 → win.webContents.send(dataChannel, chunk)  # 렌더러로 중계
  ...
자식 종료(exit) → onChildExit?.() + setChild(null) + send(endedChannel, {code})
사용자 stop → stopCapture()/stopPlayCapture() → child 참조를 먼저 비운 뒤 SIGTERM (ended 이벤트 억제)
```

`audio-playcapture:start` 전 단계(재생 참조 PCM 업로드):

```
렌더러: start-write → writeId 수신
       → write-chunk(writeId, chunk) 반복 (내부 stream.write가 false면 drain까지 대기)
       → finalize-write(writeId) → 메인이 임시 .f32 경로를 finalizedRefs에 보관
렌더러: audio-playcapture:start({ refWriteId, outputChannel, ... })
       → finalizedRefs에서 경로 회수 → --ref <path> [--out-ch <n>] 인자로 헬퍼 실행
```

## 5. 주요 인터페이스 / 진입점

IPC 채널(렌더러 쪽 호출은 `preload.js`의 `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`, 상세 시그니처는 `electron/README.md` 5절 참고):

- `audio-device:list` / `:get-config` / `:set-config` / `:query` — 헬퍼 1회 실행, JSON 응답. `deviceUID` 생략 시 OS 기본 입력 대상.
- `audio-capture:start({ sampleRate, bufferSize, channels, deviceUID })` / `:stop` — 상주 `capture` IOProc 시작/종료. 이미 실행 중이면 `start`가 `{ success: false, error: "capture-already-running" }`.
- `audio-playcapture:start-write` → `{ writeId }` / `:write-chunk({ writeId, chunk })` / `:finalize-write({ writeId })` / `:cancel-write({ writeId })` — 재생 참조 PCM 청크 업로드 핸드셰이크.
- `audio-playcapture:start({ sampleRate, bufferSize, channels, deviceUID, refWriteId, outputChannel })` — `refWriteId`가 가리키는 finalize된 ref 파일이 없으면 `{ success: false, error: "missing-ref-write-id" }`. 이미 실행 중이면 `"play-capture-already-running"`.
- `audio-playcapture:control({ action: "pause" | "resume" })` / `:stop` — 재생 중인 헬퍼 stdin에 라인 명령 중계.
- `audio-capture:data` / `audio-capture:ended` / `audio-playcapture:data` / `audio-playcapture:ended` — 메인 → 렌더러 이벤트(웹훅형, `ipcRenderer.on`). `data`는 raw PCM 청크, `ended`는 `{ code }`(0 = 정상 종료).
- `local-folder:select` → `{ canceled, folderPath?, files?, error? }` / `:unwatch` / `:read-file(filePath)` → `{ success, data?: Uint8Array, mime?, error? }`.
- `local-folder:changed` — 메인 → 렌더러 이벤트. 감시 중인 폴더 내용이 바뀔 때마다 최신 파일 목록을 통째로 보낸다.
- `stopCapture()` / `stopPlayCapture()` / `stopWatchingFolder()` — Node 모듈 함수 export(IPC 채널 아님). `electron/main.js` 전용 진입점.
- `runStreamingHelper({ event, helperPath, args, dataChannel, endedChannel, setChild, isCurrentChild, stopActiveChild, onChildError?, onChildExit? }): Promise<{success, ...}>` — `audio-capture.js`/`audio-playcapture.js` 전용 내부 공용 함수(IPC 채널 아님).

## 6. 변경 이력(요약)
- 2026-07-20: 최초 작성 (기준 커밋: fb8e4fa — `electron/`은 `.gitignore`(`/electron/`)로 커밋 이력 추적 밖에 있어 git log 대신 현재 코드를 직접 읽어 작성)
