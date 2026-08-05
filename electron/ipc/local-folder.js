// electron/ipc/local-folder.js — 로컬 폴더 연결 (워크스페이스 "로컬 폴더" 기능).
//
// 사용자가 고른 폴더 안의 오디오 파일만 나열하고, fs.watch로 변경을 감시해 렌더러
// (Workspace-context)에 목록을 다시 밀어준다. 파일 읽기는 마지막으로 select()된 폴더
// (allowedFolderPath) 하위 경로만 허용해 임의 경로 읽기를 막는다.
const { BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

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
  const relative = path.relative(path.resolve(allowedFolderPath), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
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

// main.js 앱 라이프사이클(window-all-closed)이 호출해 폴더 감시를 정리한다.
module.exports = { stopWatchingFolder };
