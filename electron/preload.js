// preload.js — sandbox: true인 렌더러에 audio-device IPC만 최소한으로 노출한다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("audioDevice", {
  getConfig: () => ipcRenderer.invoke("audio-device:get-config"),
  setConfig: (sampleRate, bufferSize) =>
    ipcRenderer.invoke("audio-device:set-config", { sampleRate, bufferSize }),
});
