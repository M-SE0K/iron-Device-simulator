# audio-device-helper — CoreAudio HAL 헬퍼 (macOS 전용)

Electron 메인 프로세스(`electron/main.js`)가 `child_process`로 실행하는 컴파일된
CLI. Web Audio API/`getUserMedia`는 CoreAudio HAL 프로퍼티(NominalSampleRate,
BufferFrameSize)에 접근할 방법이 없어서, 이 별도 바이너리가 그 다리 역할을 한다.
항상 **OS 기본 입력 장치**(사용자가 앱 실행 전 Audio MIDI 설정 등에서 지정해둔 장치,
예: MCHStreamer AllRate)를 대상으로 동작한다 — 장치 이름을 인자로 받지 않는다.

## 명령어

모든 명령은 `--device <UID>`(선택)로 대상 장치를 지정할 수 있고, 생략하면 **OS 기본 입력 장치**를 쓴다(기존 동작). `<UID>`는 `list`가 돌려주는 각 장치의 `uid`다.

```bash
# 연결된 입력 장치 전체 열거 (uid/name/inputChannels/isDefault) — 장치 선택 드롭다운용
native/macos/audio-device-helper/dist/audio-device-helper list

# 조회 (현재값만)
native/macos/audio-device-helper/dist/audio-device-helper get [--device <UID>]

# 능력 조회 (현재값 + 지원 SampleRate 목록 + Buffer 허용 범위 + 입력 채널 수) — UI 장치 패널용
native/macos/audio-device-helper/dist/audio-device-helper query [--device <UID>]

# 설정 (sampleRate: Hz, bufferSize: samples/frame) — ⚠️ bufferSize는 지속되지 않음, 아래 참고
native/macos/audio-device-helper/dist/audio-device-helper set [--device <UID>] <sampleRate> <bufferSize>

# 상주 캡처 (sampleRate/bufferSize 적용 + 캡처 스트리밍) — bufferSize가 실제 적용되는 유일한 모드
native/macos/audio-device-helper/dist/audio-device-helper capture [--device <UID>] <sampleRate> <bufferSize> [channels=2]

# 파일 재생 + 캡처 (연속 재생, 단일 IOProc) — Electron 파일 모드의 재생/분석 경로
native/macos/audio-device-helper/dist/audio-device-helper play-capture [--device <UID>] --ref <path> [--ref-channels <1|2>] [--out-ch <n>] [--out-ch-r <n>] <sampleRate> <bufferSize> [channels=2]
# 예
native/macos/audio-device-helper/dist/audio-device-helper capture 48000 480 2
native/macos/audio-device-helper/dist/audio-device-helper query --device BuiltInMicrophoneDevice
```

`list`/`get`/`query`/`set` 출력은 한 줄 JSON(stdout).

```json
// list — 입력 채널이 1개 이상인 장치만. app CalibrationDrawer의 "Capture Device" 드롭다운을 채운다
{
  "success": true,
  "devices": [
    { "uid": "AppleUSBAudioEngine:miniDSP:MCHStreamer AllRate:00006:1,2", "name": "MCHStreamer AllRate", "inputChannels": 8, "sampleRate": 48000, "isDefault": true },
    { "uid": "BuiltInMicrophoneDevice", "name": "MacBook Pro 마이크", "inputChannels": 1, "sampleRate": 88200, "isDefault": false }
  ]
}

// get
{ "success": true, "device": "MCHStreamer AllRate", "deviceUID": "AppleUSBAudioEngine:...", "actual": { "sampleRate": 48000, "bufferSize": 512 } }

// query — CalibrationDrawer "연결된 장치" 패널이 이걸 파싱해 표시한다.
// outputChannels가 0이면 입력 전용 장치 — play-capture(파일 재생)가 불가능하다.
{
  "success": true,
  "device": "MCHStreamer AllRate",
  "current": { "sampleRate": 48000, "bufferSize": 512 },
  "supportedSampleRates": [8000, 44100, 48000, 96000, 192000, 384000],
  "bufferRange": { "min": 15, "max": 4096 },
  "inputChannels": 8,
  "outputChannels": 8
}

// set
{
  "success": true,
  "device": "MCHStreamer AllRate",
  "requested": { "sampleRate": 48000, "bufferSize": 480 },
  "actual": { "sampleRate": 48000, "bufferSize": 480 }
}
```

`success:false`면 `error` 키에 사유가 담긴다(`no-default-input-device`, `usage: ...` 등).

> `query`가 보여주는 `current.bufferSize`는 per-client(TN2321)라 이 조회 프로세스가 보는
> **장치 기본값**이다 — capture로 요청한 값(예: 1024)은 그 IOProc 안에서만 적용되며 별도
> 조회로는 관찰되지 않는다. 아래 "`set`의 한계와 `capture` 모드" 참고.

## src/query-device.c — 장치 능력 진단 CLI (개발용)

헬퍼 소스는 `src/`에 있다 — 앱에 번들되는 CoreAudio 헬퍼가 `src/mac.swift`, 그리고 개발용
진단 도구가 `src/query-device.c`다. 후자는 **기본 입력 장치에 묶이지 않고** 장치를 이름으로 찾아
같은 정보(현재값·지원 SampleRate·Buffer 범위·입력 채널 수)를 사람이 읽기 좋은 형태로 출력하는
독립 진단 도구다. 앱(Electron)은 이 C 도구가 아니라 위 Swift 헬퍼의 `query`를 쓴다 —
실제 캡처가 대상으로 삼는 "기본 입력 장치"와 일치하기 때문. `src/query-device.c`는 여러 장치를
비교하거나 기본 장치가 아닌 장치를 확인할 때 쓴다.

```bash
cc -O2 -o dist/query-device src/query-device.c -framework CoreAudio -framework CoreFoundation
./dist/query-device            # 이름에 "MCHStreamer" 포함된 입력 장치
./dist/query-device Scarlett   # 다른 장치 이름 일부로 필터
./dist/query-device --all      # 모든 입력 장치
```

## 빌드

```bash
./native/macos/audio-device-helper/build-mac.sh
```
`swiftc`로 arm64/x64를 각각 컴파일 후 `lipo`로 합쳐 universal binary
(`dist/audio-device-helper`)를 만든다 — electron-builder mac 타깃(`[x64, arm64]`)과
아키텍처 분기 없이 매칭된다. `scripts/build/build-electron.sh`가 mac 패키징 전에 자동 호출한다.

## ⚠️ `set`의 한계와 `capture` 모드

`get`/`set`은 **1회성 프로세스**(실행 → 결과 출력 → 즉시 종료)다. 실측 결과:

- **SampleRate**는 프로세스가 종료된 뒤에도 유지된다 — CoreAudio HAL에서 NominalSampleRate는
  장치의 지속적인 "포맷" 설정이라, 아무 프로세스가 없어도 그대로 남아있다.
- **BufferFrameSize는 설정한 프로세스가 종료되는 즉시 장치 기본값으로 되돌아간다**
  (이 장치는 512). TN2321대로 이 값은 **그 I/O를 실제로 여는 클라이언트가 주인**인
  per-client 프로퍼티라서, I/O 없이 set만 하고 종료하는 프로세스로는 유지할 수 없고,
  다른 프로세스(예: getUserMedia를 여는 Chromium)의 캡처 버퍼에도 영향을 주지 못한다.

`capture` 모드가 이 한계의 해결책이다: 헬퍼 **자신이 IOProc을 열어 캡처 I/O의 주인이
되므로** 요청한 BufferFrameSize가 실제 적용·유지된다 (MCHStreamer AllRate에서 480 적용
실측 확인). 대신 캡처 데이터도 이 프로세스가 공급해야 하므로, `MicrophonePlayer.tsx`는
Electron 환경(`window.audioCapture` 존재)에서 getUserMedia 대신 이 경로를 쓴다.

### capture 프로토콜

- **stdout 첫 줄**: JSON 헤더 — `{"success":true,"device":"...","channels":2,"requested":{...},"actual":{"sampleRate":48000,"bufferSize":480}}`
  (`success:false`면 헤더만 출력하고 종료)
- **이후 stdout**: int16 인터리브 raw PCM 스트림 (장치 SampleRate, `channels`개 채널).
  HAL 입력(Float32)을 앞쪽 `channels`개 채널만 변환한다 — MCHStreamer 같은 다채널
  장치에서 V/I 센싱 채널을 받으려면 `channels`를 늘리면 된다. 모노 장치는 ch0을 ch1에 복제.
  `channels`는 CalibrationDrawer의 **Capture Channels** 필드(`calibration.channels`)에서
  오고, `MicrophonePlayer.tsx`가 N채널 인터리브에서 **ch0/ch1만 뽑아** 3840바이트 2ch
  분석 프레임으로 재구성한다(분석 파이프라인은 항상 2ch 고정). 나머지 채널은 향후 V/I 센싱용.
- **종료**: SIGTERM/SIGINT, stdin EOF(부모 Electron 사망 시 파이프 닫힘 → 고아 방지), 또는
  장치 연결 해제(**exit 3** — 아래 "장치 연결 해제 감지" 참고).
- bufferSize는 `kAudioDevicePropertyBufferFrameSizeRange`로 조회한 장치 허용 범위로 클램프된다.

### 장치 연결 해제(disconnect) 감지

`capture`/`play-capture` 두 상주 모드 모두 `installResidentLifecycle`이 장치의
`kAudioDevicePropertyDeviceIsAlive` 프로퍼티에 리스너를 건다(`installDeviceIsAliveListener`).
IOProc 실행 중 USB 분리 등으로 장치가 죽으면 이 프로퍼티가 0이 되고, 헬퍼는 즉시
**exit 3**으로 자기 종료한다 — 리스너가 없으면 IOProc이 데이터 없이 조용히 멈추고
부모/렌더러는 아무 신호도 못 받아 사용자가 직접 정지할 때까지 화면이 얼어붙는다.
부모(`audio-capture.js`/`audio-playcapture.js`)는 이 종료 코드를 그대로 `ended` 이벤트에
실어 렌더러로 넘기고, 렌더러(`useNativeCapture.ts`의 `offEnded`)는 code 3을 일반 크래시와
구분해 "장치 연결이 끊겼습니다" 안내를 보여준다.

### play-capture 프로토콜 (파일 재생 + 캡처, 단일 IOProc)

Electron 파일 모드의 재생·분석 경로가 쓴다(`electron/ipc/audio-playcapture.js` →
`window.audioPlayCapture`). 입출력 겸용 단일 장치에 IOProc 하나를 열어 재생과 캡처가
**같은 클록** 위에 놓인다 — 렌더러는 수신한 캡처 프레임 수만으로 재생 위치를 계산한다.

- **`--ref <path>`**: 재생할 신호 전체. raw little-endian **Float32** ([-1,1] 정규화),
  요청 sampleRate로 미리 디코드/리샘플된 것 — `--ref-channels 1`(기본)이면 모노 플랫,
  `2`면 인터리브 스테레오(`[L0,R0,L1,R1,...]`)로 해석해 프레임 단위로 L/R을 분리한다.
- **`--out-ch <n>`** (선택, 생략 시 0): ref(L)를 내보낼 출력 채널 인덱스. 장치의 실제 출력
  채널 수(`outputChannelCount`, `query`의 `outputChannels`) 밖이면 시작 즉시
  `{"success":false,"error":"invalid-out-ch(n not in 0..<count)"}`로 종료한다 — L은 필수 검증이다.
- **`--out-ch-r <n>`** (선택): ref(R)를 내보낼 출력 채널 인덱스 — `--ref-channels 2`와 함께 쓴다.
  L과 달리 **best-effort**다: 범위 밖이거나 `--out-ch`와 같으면 에러로 종료하지 않고 조용히
  스테레오를 포기해 R 없이(모노로) 재생한다 — 응답 헤더의 `playbackChannelR`이 `null`이면
  폴백된 것. 렌더러(`useCaptureSession.ts`)는 항상 `outputChannel + 1`을 보낸다(Output Channel
  선택 UI는 UX상 의도적으로 없음 — 하드코딩된 인접 채널 배관).
- **stdout 첫 줄**: JSON 헤더 — capture 헤더 + `"mode":"play-capture"`, `"refLen"`(재생 총
  프레임), `"playbackChannel"`(실제 사용된 L 출력 채널 — `--out-ch` 요청값을 그대로 echo),
  `"playbackChannelR"`(실제 사용된 R 출력 채널, 모노로 폴백됐으면 `null`).
  (`success:false`면 헤더만 출력하고 종료 — `device-has-no-output(...)`: 출력 채널이 없는
  장치, `invalid-out-ch(...)`: L이 범위 밖인 채널 인덱스)
- **이후 stdout**: capture 모드와 동일한 int16 인터리브 캡처 PCM 스트림.
  **pause 중에도 캡처는 계속 흐른다** — 차트/저장 게이트는 렌더러(`recordingActiveRef`/
  `analysisActiveRef`) 몫이고, WASM 온도 상태 유지를 위해 세션은 끊지 않는 설계.
- **stdin 라인 명령**: `pause\n`(출력 무음 + 재생 위치 동결) / `resume\n` / `stop\n`(즉시 종료).
  알 수 없는 명령은 무시. stdin EOF는 여전히 부모 사망으로 취급해 종료한다.
- **종료**: 재생 끝(`refLen` + 감쇠 테일 0.25 s) 도달 시 **exit 0으로 자기 종료** — 부모는
  exit 이벤트의 code 0을 "재생 완료"로 해석한다(사용자 stop은 부모가 child 참조를 먼저 지워
  ended 이벤트 자체를 억제). 장치 연결 해제 시에는 capture와 동일하게 **exit 3**(위 "장치
  연결 해제 감지" 참고).

### 마이크 권한 (TCC)

권한이 없으면 macOS는 에러 대신 **무음(전부 0)** 을 준다. Electron이 spawn하면 앱의
마이크 권한을 따라가지만, 터미널에서 직접 실행해 테스트할 때는 해당 터미널 앱에
시스템 설정 > 개인정보 보호 및 보안 > 마이크 권한이 있어야 실제 신호가 들어온다.
