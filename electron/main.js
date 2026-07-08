// electron/main.js — Electron 메인 프로세스 (합성 루트)
//
// out/(scripts/build-static-local.sh 공용 코어 산출물, 브라우저 WASM 엔진 · 서버리스)을
// BrowserWindow에 그대로 띄운다. 로컬 정적 서버는 ./server가 맡고, 오디오 장치/캡처/
// 로컬 폴더 IPC는 ./ipc/*.js가 각자 require 시점에 자신의 채널을 등록한다(부수효과) —
// 이 파일은 앱 라이프사이클(창 생성/종료)만 담당한다.
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { PORT, startServer } = require("./server");
const { stopCapture } = require("./ipc/audio-capture");
const { stopWatchingFolder } = require("./ipc/local-folder");
require("./ipc/audio-device"); // IPC 채널 등록(부수효과) — audio-capture도 내부적으로 재사용

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
