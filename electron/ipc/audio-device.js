// electron/ipc/audio-device.js — audio-device-helper: OS 기본 입력 장치(MCHStreamer 등)의
// CoreAudio HAL SampleRate/BufferFrameSize를 조회·설정하는 컴파일된 바이너리 — macOS 전용.
// Windows/Linux 확장 시 이 자리에 각 플랫폼 헬퍼를 추가하고 아래 분기만 넓히면 된다.
const { app, ipcMain } = require("electron");
const path = require("path");
const { execFile } = require("child_process");

const AUDIO_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "audio-device-helper")
  : path.join(__dirname, "..", "native", "audio-device-helper", "dist", "audio-device-helper");

function runAudioHelper(args) {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve({ success: false, error: "unsupported-platform" });
      return;
    }
    execFile(AUDIO_HELPER_PATH, args, (err, stdout) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ success: false, error: "invalid-helper-output" });
      }
    });
  });
}

// deviceUID가 있으면 `--device <UID>`를 덧붙여 특정 장치를 대상으로, 없으면 OS 기본 입력을 쓴다.
function withDevice(baseArgs, deviceUID) {
  return deviceUID ? [...baseArgs, "--device", String(deviceUID)] : baseArgs;
}

// 연결된 입력 장치 전체 열거(uid/name/inputChannels/isDefault) — UI 장치 선택 드롭다운용.
ipcMain.handle("audio-device:list", () => runAudioHelper(["list"]));
ipcMain.handle("audio-device:get-config", (_event, opts) =>
  runAudioHelper(withDevice(["get"], opts?.deviceUID))
);
ipcMain.handle("audio-device:set-config", (_event, { sampleRate, bufferSize, deviceUID }) =>
  runAudioHelper(withDevice(["set", String(sampleRate), String(bufferSize)], deviceUID))
);
// 장치 능력 조회(현재값 + 지원 SampleRate 목록 + Buffer 범위 + 입력 채널 수) — UI 장치 정보 패널용.
ipcMain.handle("audio-device:query", (_event, opts) =>
  runAudioHelper(withDevice(["query"], opts?.deviceUID))
);

// audio-capture.js가 같은 헬퍼 바이너리/인자 규칙을 재사용한다.
module.exports = { AUDIO_HELPER_PATH, withDevice };
