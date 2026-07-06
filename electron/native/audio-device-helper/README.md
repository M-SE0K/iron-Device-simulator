# audio-device-helper — CoreAudio HAL 헬퍼 (macOS 전용)

Electron 메인 프로세스(`electron/main.js`)가 `child_process.execFile`로 실행하는 컴파일된
CLI. Web Audio API/`getUserMedia`는 CoreAudio HAL 프로퍼티(NominalSampleRate,
BufferFrameSize)에 접근할 방법이 없어서, 이 별도 바이너리가 그 다리 역할을 한다.
항상 **OS 기본 입력 장치**(사용자가 앱 실행 전 Audio MIDI 설정 등에서 지정해둔 장치,
예: MCHStreamer AllRate)를 대상으로 동작한다 — 장치 이름을 인자로 받지 않는다.

## 명령어

```bash
# 조회
electron/native/audio-device-helper/dist/audio-device-helper get

# 설정 (sampleRate: Hz, bufferSize: samples/frame)
electron/native/audio-device-helper/dist/audio-device-helper set <sampleRate> <bufferSize>
# 예
electron/native/audio-device-helper/dist/audio-device-helper set 48000 480
```

출력은 항상 한 줄 JSON(stdout).

```json
// get
{ "success": true, "device": "MCHStreamer AllRate", "actual": { "sampleRate": 48000, "bufferSize": 512 } }

// set
{
  "success": true,
  "device": "MCHStreamer AllRate",
  "requested": { "sampleRate": 48000, "bufferSize": 480 },
  "actual": { "sampleRate": 48000, "bufferSize": 480 }
}
```

`success:false`면 `error` 키에 사유가 담긴다(`no-default-input-device`, `usage: ...` 등).

## 빌드

```bash
./electron/native/audio-device-helper/build-mac.sh
```
`swiftc`로 arm64/x64를 각각 컴파일 후 `lipo`로 합쳐 universal binary
(`dist/audio-device-helper`)를 만든다 — electron-builder mac 타깃(`[x64, arm64]`)과
아키텍처 분기 없이 매칭된다. `scripts/build-electron.sh`가 mac 패키징 전에 자동 호출한다.

## ⚠️ 알려진 한계: BufferSize는 지속되지 않는다

`get`/`set` 모두 **1회성 프로세스**(실행 → 결과 출력 → 즉시 종료)다. 실측 결과:

- **SampleRate**는 프로세스가 종료된 뒤에도 유지된다 — CoreAudio HAL에서 NominalSampleRate는
  장치의 지속적인 "포맷" 설정이라, 아무 프로세스가 없어도 그대로 남아있다.
- **BufferFrameSize는 설정한 프로세스가 종료되는 즉시 장치 기본값으로 되돌아간다**
  (이 장치는 512). `set`이 성공(`success:true`)하고 그 직후 재조회하면 요청값이 그대로
  보이지만, 그건 아직 우리 프로세스가 살아있을 때의 순간값일 뿐이고, 별도 프로세스로
  다시 조회하면 이미 리셋돼 있다.

원인은 CoreAudio HAL에서 BufferFrameSize가 **그 값을 실제로 사용하는 활성 오디오
스트림(IOProc)이 있어야만 유지되는 프로퍼티**이기 때문으로 보인다. 이 헬퍼는 스트림을
전혀 열지 않고 프로퍼티만 설정하고 종료하므로, 종료 순간 그 값을 붙잡고 있는 주체가
없어져 드라이버 기본값으로 리셋된다. 즉 지금 구조(1회성 CLI)로는 BufferSize를 영구
반영할 수 없다 — IPC/UI 배선 문제가 아니라 구조적 한계다.

**다음에 시도해볼 방향** (아직 미구현):
- 실제 오디오 캡처가 시작되는 시점(예: `MicrophonePlayer.tsx`의 `getUserMedia` 호출
  직전/직후)에 맞춰 설정 → 그 캡처 스트림 자체가 활성 IOProc이 되어 값을 붙잡아줄 가능성.
- 헬퍼를 1회성 CLI 대신, 최소한의 IOProc을 직접 열고 앱 종료 시까지 떠 있는 상주
  프로세스로 재설계.
