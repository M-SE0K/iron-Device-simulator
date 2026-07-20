// electron/ipc/audio-capture.js — 네이티브 오디오 캡처 (상주형 헬퍼).
//
// `capture` 모드는 헬퍼가 캡처 I/O(IOProc)를 직접 열어 BufferFrameSize의 주인이 되므로
// 1회성 set과 달리 요청한 버퍼 크기가 실제 적용·유지된다 (native/macos/audio-device-helper/README.md).
// 헬퍼 stdout: 첫 줄 JSON 헤더 → 이후 int16 인터리브 raw PCM. 청크를 그대로 렌더러에 중계한다.
const { ipcMain } = require("electron");
const { AUDIO_HELPER_PATH, SUPPORTED_PLATFORMS, withDevice } = require("./audio-device");
const { runStreamingHelper } = require("./run-streaming-helper");

let captureChild = null;

function stopCapture() {
  if (!captureChild) return { success: true };
  const child = captureChild;
  captureChild = null; // exit 핸들러가 "ended" 이벤트를 보내지 않도록 먼저 비운다 (사용자 주도 종료)
  child.kill("SIGTERM");
  return { success: true };
}

ipcMain.handle("audio-capture:start", (event, { sampleRate, bufferSize, channels, deviceUID }) => {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
    return { success: false, error: "unsupported-platform" };
  }
  if (captureChild) {
    return { success: false, error: "capture-already-running" };
  }
  return runStreamingHelper({
    event,
    helperPath: AUDIO_HELPER_PATH,
    args: withDevice(["capture", String(sampleRate), String(bufferSize), String(channels || 2)], deviceUID),
    dataChannel: "audio-capture:data",
    endedChannel: "audio-capture:ended",
    setChild: (child) => { captureChild = child; },
    isCurrentChild: (child) => captureChild === child,
    stopActiveChild: stopCapture,
  });
});

ipcMain.handle("audio-capture:stop", () => stopCapture());

// main.js 앱 라이프사이클(window-all-closed/before-quit)이 호출해 자식 프로세스를 정리한다.
module.exports = { stopCapture };
