// electron/main.js — Electron 메인 프로세스
//
// out/(scripts/build-static-local.sh 공용 코어 산출물, 브라우저 WASM 엔진 · 서버리스)을
// BrowserWindow에 그대로 띄운다. Next.js 정적 export는 애셋 경로가 절대경로(/_next/...)라
// file://로 직접 열면 로딩이 깨지므로, 앱 내부에서만 쓰는 로컬 정적 서버를 띄워
// http://127.0.0.1:<port>로 로드한다 — 외부에 노출되지 않고 이 프로세스 안에서만 존재하는
// 서버라 "서버리스(분석은 브라우저 WASM이 수행)" 원칙과 어긋나지 않는다.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { execFile } = require("child_process");

const PORT = 17872;

const OUT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "out")
  : path.join(__dirname, "..", "out");

// audio-device-helper: OS 기본 입력 장치(MCHStreamer 등)의 CoreAudio HAL
// SampleRate/BufferFrameSize를 조회·설정하는 컴파일된 바이너리 — macOS 전용.
// Windows/Linux 확장 시 이 자리에 각 플랫폼 헬퍼를 추가하고 아래 분기만 넓히면 된다.
const AUDIO_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "audio-device-helper")
  : path.join(__dirname, "native", "audio-device-helper", "dist", "audio-device-helper");

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

ipcMain.handle("audio-device:get-config", () => runAudioHelper(["get"]));
ipcMain.handle("audio-device:set-config", (_event, { sampleRate, bufferSize }) =>
  runAudioHelper(["set", String(sampleRate), String(bufferSize)])
);

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
      const requested = safePath === "/" ? "/index.html" : safePath;
      const filePath = path.join(OUT_DIR, requested);

      // Next.js static export writes page routes as <route>.html
      fs.access(filePath, fs.constants.F_OK, (err) => {
        if (!err) return serveFile(res, filePath);
        serveFile(res, path.join(OUT_DIR, `${requested}.html`));
      });
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve());
  });
}

async function createWindow() {
  await startServer();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
