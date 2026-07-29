// electron/ipc/audio-device.js — audio-device-helper: OS 기본 입력 장치(MCHStreamer 등)의
// SampleRate/BufferFrameSize를 조회·설정하는 컴파일된 바이너리. macOS는 native/macos/
// audio-device-helper/ (Swift/CoreAudio), Windows는 native/windows/audio-device-helper/
// ASIO/C++ 구현이며 build-win.sh로 audio-device-helper.exe를 생성한다; 빌드 전에는 dev 실행이 ENOENT로 실패한다.
const { app, ipcMain } = require("electron");
const path = require("path");
const { execFile } = require("child_process");

const SUPPORTED_PLATFORMS = ["darwin", "win32"];

// 플랫폼별 헬퍼 바이너리 이름/소스 폴더 — electron-builder.yml의 mac/win extraResources도
// 이 이름 규칙(패키징 시 리소스 루트에 "audio-device-helper"(.exe))을 따라야 한다.
const HELPER_BINARY_NAME = process.platform === "win32" ? "audio-device-helper.exe" : "audio-device-helper";
const HELPER_SOURCE_DIR = process.platform === "win32" ? "windows" : "macos";

// dev 폴백(!isPackaged)의 __dirname은 webpack 번들 결과 기준(electron-dist/,
// project root 바로 아래 — webpack.electron.config.js 참고)이라 electron/ipc/
// 원본 위치보다 한 단계 얕다. native/는 electron/에서 프로젝트 최상위로 이동했으므로
// project root 기준 "native/..."로 곧장 진입한다.
const AUDIO_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, HELPER_BINARY_NAME)
  : path.join(__dirname, "..", "native", HELPER_SOURCE_DIR, "audio-device-helper", "dist", HELPER_BINARY_NAME);

function runAudioHelper(args) {
  return new Promise((resolve) => {
    if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
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

// audio-capture.js/audio-playcapture.js가 같은 헬퍼 바이너리/인자 규칙 및 지원 플랫폼 판정을 재사용한다.
module.exports = { AUDIO_HELPER_PATH, SUPPORTED_PLATFORMS, withDevice };
