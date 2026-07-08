// electron/ipc/audio-capture.js — 네이티브 오디오 캡처 (상주형 헬퍼).
//
// `capture` 모드는 헬퍼가 캡처 I/O(IOProc)를 직접 열어 BufferFrameSize의 주인이 되므로
// 1회성 set과 달리 요청한 버퍼 크기가 실제 적용·유지된다 (native/audio-device-helper/README.md).
// 헬퍼 stdout: 첫 줄 JSON 헤더 → 이후 int16 인터리브 raw PCM. 청크를 그대로 렌더러에 중계한다.
const { BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const { AUDIO_HELPER_PATH, withDevice } = require("./audio-device");

let captureChild = null;

function stopCapture() {
  if (!captureChild) return { success: true };
  const child = captureChild;
  captureChild = null; // exit 핸들러가 "ended" 이벤트를 보내지 않도록 먼저 비운다 (사용자 주도 종료)
  child.kill("SIGTERM");
  return { success: true };
}

ipcMain.handle("audio-capture:start", (event, { sampleRate, bufferSize, channels, deviceUID }) => {
  if (process.platform !== "darwin") {
    return { success: false, error: "unsupported-platform" };
  }
  if (captureChild) {
    return { success: false, error: "capture-already-running" };
  }
  const win = BrowserWindow.fromWebContents(event.sender);

  return new Promise((resolve) => {
    const child = spawn(
      AUDIO_HELPER_PATH,
      withDevice(["capture", String(sampleRate), String(bufferSize), String(channels || 2)], deviceUID)
    );
    captureChild = child;

    let headerBuf = Buffer.alloc(0);
    let headerDone = false;
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    child.stdout.on("data", (chunk) => {
      if (headerDone) {
        if (!win.isDestroyed()) win.webContents.send("audio-capture:data", chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const nl = headerBuf.indexOf(0x0a);
      if (nl === -1) return;
      headerDone = true;
      let header;
      try {
        header = JSON.parse(headerBuf.subarray(0, nl).toString("utf8"));
      } catch {
        header = { success: false, error: "invalid-helper-output" };
      }
      if (!header.success) {
        stopCapture();
      } else {
        const rest = headerBuf.subarray(nl + 1);
        if (rest.length > 0 && !win.isDestroyed()) win.webContents.send("audio-capture:data", rest);
      }
      settle(header);
    });

    child.on("error", (err) => {
      if (captureChild === child) captureChild = null;
      settle({ success: false, error: err.message });
    });

    child.on("exit", (code) => {
      if (captureChild === child) {
        captureChild = null;
        if (!win.isDestroyed()) win.webContents.send("audio-capture:ended", { code });
      }
      settle({ success: false, error: `helper-exited(${code})` });
    });
  });
});

ipcMain.handle("audio-capture:stop", () => stopCapture());

// main.js 앱 라이프사이클(window-all-closed/before-quit)이 호출해 자식 프로세스를 정리한다.
module.exports = { stopCapture };
