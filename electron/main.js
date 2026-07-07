// electron/main.js — Electron 메인 프로세스
//
// out/(scripts/build-static-local.sh 공용 코어 산출물, 브라우저 WASM 엔진 · 서버리스)을
// BrowserWindow에 그대로 띄운다. Next.js 정적 export는 애셋 경로가 절대경로(/_next/...)라
// file://로 직접 열면 로딩이 깨지므로, 앱 내부에서만 쓰는 로컬 정적 서버를 띄워
// http://127.0.0.1:<port>로 로드한다 — 외부에 노출되지 않고 이 프로세스 안에서만 존재하는
// 서버라 "서버리스(분석은 브라우저 WASM이 수행)" 원칙과 어긋나지 않는다.
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { execFile, spawn } = require("child_process");

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
// 장치 능력 조회(현재값 + 지원 SampleRate 목록 + Buffer 범위 + 입력 채널 수) — UI 장치 정보 패널용.
ipcMain.handle("audio-device:query", () => runAudioHelper(["query"]));

// ── 네이티브 오디오 캡처 (상주형 헬퍼) ──────────────────────────────────────
// `capture` 모드는 헬퍼가 캡처 I/O(IOProc)를 직접 열어 BufferFrameSize의 주인이 되므로
// 1회성 set과 달리 요청한 버퍼 크기가 실제 적용·유지된다 (native/audio-device-helper/README.md).
// 헬퍼 stdout: 첫 줄 JSON 헤더 → 이후 int16 인터리브 raw PCM. 청크를 그대로 렌더러에 중계한다.
let captureChild = null;

function stopCapture() {
  if (!captureChild) return { success: true };
  const child = captureChild;
  captureChild = null; // exit 핸들러가 "ended" 이벤트를 보내지 않도록 먼저 비운다 (사용자 주도 종료)
  child.kill("SIGTERM");
  return { success: true };
}

ipcMain.handle("audio-capture:start", (event, { sampleRate, bufferSize, channels }) => {
  if (process.platform !== "darwin") {
    return { success: false, error: "unsupported-platform" };
  }
  if (captureChild) {
    return { success: false, error: "capture-already-running" };
  }
  const win = BrowserWindow.fromWebContents(event.sender);

  return new Promise((resolve) => {
    const child = spawn(AUDIO_HELPER_PATH, [
      "capture",
      String(sampleRate),
      String(bufferSize),
      String(channels || 2),
    ]);
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

// ── 로컬 폴더 연결 (워크스페이스 "로컬 폴더" 기능) ───────────────────────────
// 사용자가 고른 폴더 안의 오디오 파일만 나열하고, fs.watch로 변경을 감시해
// 렌더러(Workspace-context)에 목록을 다시 밀어준다. 파일 읽기는 마지막으로
// select()된 폴더(allowedFolderPath) 하위 경로만 허용해 임의 경로 읽기를 막는다.
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".wma"]);
const AUDIO_MIME_TYPES = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".wma": "audio/x-ms-wma",
};

let allowedFolderPath = null;
let currentWatcher = null;
let watchedFolderPath = null;
let watchDebounceTimer = null;

function scanAudioFolder(folderPath) {
  return new Promise((resolve, reject) => {
    fs.readdir(folderPath, { withFileTypes: true }, (err, entries) => {
      if (err) return reject(err);
      const audioEntries = entries.filter(
        (e) => e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())
      );
      Promise.all(
        audioEntries.map(
          (e) =>
            new Promise((res) => {
              const filePath = path.join(folderPath, e.name);
              fs.stat(filePath, (statErr, stat) => {
                res(statErr ? null : { name: e.name, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
              });
            })
        )
      ).then((results) => resolve(results.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))));
    });
  });
}

function stopWatchingFolder() {
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
  }
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = null;
  }
  watchedFolderPath = null;
}

function startWatchingFolder(folderPath, win) {
  stopWatchingFolder();
  watchedFolderPath = folderPath;
  currentWatcher = fs.watch(folderPath, { persistent: true }, () => {
    if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(async () => {
      if (watchedFolderPath !== folderPath || win.isDestroyed()) return;
      try {
        win.webContents.send("local-folder:changed", await scanAudioFolder(folderPath));
      } catch {
        // 폴더가 삭제/이동된 경우 등 — 감시를 중단하고 빈 목록을 알린다.
        stopWatchingFolder();
        win.webContents.send("local-folder:changed", []);
      }
    }, 250);
  });
}

ipcMain.handle("local-folder:select", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };

  const folderPath = result.filePaths[0];
  allowedFolderPath = folderPath;
  try {
    const files = await scanAudioFolder(folderPath);
    startWatchingFolder(folderPath, win);
    return { canceled: false, folderPath, files };
  } catch (err) {
    return { canceled: false, folderPath, files: [], error: err.message };
  }
});

ipcMain.handle("local-folder:unwatch", () => {
  stopWatchingFolder();
  return { success: true };
});

ipcMain.handle("local-folder:read-file", async (_event, filePath) => {
  if (typeof filePath !== "string" || !allowedFolderPath) {
    return { success: false, error: "no-folder-connected" };
  }
  const resolved = path.resolve(filePath);
  const base = path.resolve(allowedFolderPath) + path.sep;
  if (!resolved.startsWith(base)) {
    return { success: false, error: "invalid-path" };
  }
  try {
    const data = await fs.promises.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    return { success: true, data: new Uint8Array(data), mime: AUDIO_MIME_TYPES[ext] || "application/octet-stream" };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

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
  stopWatchingFolder();
  stopCapture();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopCapture();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
