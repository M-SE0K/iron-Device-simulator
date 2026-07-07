// preload.js — sandbox: true인 렌더러에 audio-device / audio-capture / local-folder IPC만 최소한으로 노출한다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("audioDevice", {
  getConfig: () => ipcRenderer.invoke("audio-device:get-config"),
  setConfig: (sampleRate, bufferSize) =>
    ipcRenderer.invoke("audio-device:set-config", { sampleRate, bufferSize }),
  query: () => ipcRenderer.invoke("audio-device:query"),
});

contextBridge.exposeInMainWorld("audioCapture", {
  start: (opts) => ipcRenderer.invoke("audio-capture:start", opts),
  stop: () => ipcRenderer.invoke("audio-capture:stop"),
  onData: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on("audio-capture:data", listener);
    return () => ipcRenderer.removeListener("audio-capture:data", listener);
  },
  onEnded: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("audio-capture:ended", listener);
    return () => ipcRenderer.removeListener("audio-capture:ended", listener);
  },
});

contextBridge.exposeInMainWorld("localFolder", {
  select: () => ipcRenderer.invoke("local-folder:select"),
  unwatch: () => ipcRenderer.invoke("local-folder:unwatch"),
  readFile: (filePath) => ipcRenderer.invoke("local-folder:read-file", filePath),
  onChanged: (callback) => {
    const listener = (_event, files) => callback(files);
    ipcRenderer.on("local-folder:changed", listener);
    return () => ipcRenderer.removeListener("local-folder:changed", listener);
  },
});
