// electron/main.js — Electron 메인 프로세스 (합성 루트)
//
// out/(scripts/build/build-static-local.sh 공용 코어 산출물, 브라우저 WASM 엔진 · 서버리스)을
// BrowserWindow에 그대로 띄운다. 로컬 정적 서버는 ./server가 맡고, 오디오 장치/캡처/
// 로컬 폴더 IPC는 ./ipc/*.js가 각자 require 시점에 자신의 채널을 등록한다(부수효과) —
// 이 파일은 앱 라이프사이클(창 생성/종료)만 담당한다.
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { PORT, startServer } = require("./server");
const { stopCapture } = require("./ipc/audio-capture");
const { stopPlayCapture } = require("./ipc/audio-playcapture");
const { stopWatchingFolder } = require("./ipc/local-folder");
require("./ipc/audio-device"); // IPC 채널 등록(부수효과) — audio-capture/audio-playcapture도 내부적으로 재사용

// 외부 측정/자동화 도구가 실제 Electron 렌더러(네이티브 CoreAudio 경로)에 DevTools
// 프로토콜로 붙을 수 있도록 원격 디버깅 포트를 연다. 일반 배포에선 렌더러를
// 외부에 노출하지 않도록 IRON_REMOTE_DEBUG_PORT가 설정된 측정 실행에서만 켠다.
// app.whenReady() 이전(스위치는 앱 초기화 전에 등록돼야 적용됨)에 호출해야 한다.
const REMOTE_DEBUG_PORT = process.env.IRON_REMOTE_DEBUG_PORT;
if (REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", String(REMOTE_DEBUG_PORT));
  // 측정 자동화 편의: 캡처가 사용자 제스처 없이 시작될 수 있게(웹 폴백 대비) + 로컬 바인딩.
  app.commandLine.appendSwitch("remote-allow-origins", "*");
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
  stopPlayCapture();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopCapture();
  stopPlayCapture();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
