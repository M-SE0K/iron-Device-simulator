// preload.js — sandbox: true인 렌더러에 audio-device / audio-capture / local-folder IPC만 최소한으로 노출한다.
const { contextBridge, ipcRenderer } = require("electron");

function onIpc(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("audioDevice", {
  // 연결된 입력 장치 전체 열거 — 장치 선택 드롭다운용
  list: () => ipcRenderer.invoke("audio-device:list"),
  // deviceUID를 넘기면 그 장치, 생략하면 OS 기본 입력을 대상으로 한다
  getConfig: (deviceUID) => ipcRenderer.invoke("audio-device:get-config", { deviceUID }),
  setConfig: (sampleRate, bufferSize, deviceUID) =>
    ipcRenderer.invoke("audio-device:set-config", { sampleRate, bufferSize, deviceUID }),
  query: (deviceUID) => ipcRenderer.invoke("audio-device:query", { deviceUID }),
});

contextBridge.exposeInMainWorld("audioCapture", {
  start: (opts) => ipcRenderer.invoke("audio-capture:start", opts),
  stop: () => ipcRenderer.invoke("audio-capture:stop"),
  onData: (callback) => onIpc("audio-capture:data", callback),
  onEnded: (callback) => onIpc("audio-capture:ended", callback),
});

contextBridge.exposeInMainWorld("audioPlayCapture", {
  // 재생할 파일(장치 SR·mono로 디코드한 raw Float32)을 청크로 잘라 미리 전송해두는 핸드셰이크
  // — 렌더러가 startWrite → writeChunk(반복) → finalizeWrite 순으로 호출해 writeId를 얻는다.
  // 한 번의 IPC로 파일 전체를 구조화 복제 + 동기 파일쓰기하면 메인 프로세스가 멎으므로,
  // 작은 조각으로 나눠 순차 전송한다.
  startWrite: (opts) => ipcRenderer.invoke("audio-playcapture:start-write", opts),
  writeChunk: (opts) => ipcRenderer.invoke("audio-playcapture:write-chunk", opts),
  finalizeWrite: (opts) => ipcRenderer.invoke("audio-playcapture:finalize-write", opts),
  // 업로드 도중 실패/취소 시 진행 중이거나 완료된 임시 파일을 정리한다.
  cancelWrite: (opts) => ipcRenderer.invoke("audio-playcapture:cancel-write", opts),
  // 파일 재생 + 캡처 (단일 IOProc) — opts.refWriteId(finalizeWrite로 완성해둔 ref 파일)를
  // 넘기면 play-capture 헬퍼가 출력 ch0으로 재생하며 캡처를 스트리밍한다.
  start: (opts) => ipcRenderer.invoke("audio-playcapture:start", opts),
  // "pause" | "resume" — 헬퍼 stdin 라인 명령 중계 (재생 위치 동결/재개, 캡처는 계속)
  control: (action) => ipcRenderer.invoke("audio-playcapture:control", { action }),
  stop: () => ipcRenderer.invoke("audio-playcapture:stop"),
  onData: (callback) => onIpc("audio-playcapture:data", callback),
  // code 0 = 재생 완료(헬퍼 자기 종료), 그 외 = 비정상 종료. 사용자 stop 시에는 오지 않는다.
  onEnded: (callback) => onIpc("audio-playcapture:ended", callback),
});

contextBridge.exposeInMainWorld("localFolder", {
  select: () => ipcRenderer.invoke("local-folder:select"),
  unwatch: () => ipcRenderer.invoke("local-folder:unwatch"),
  readFile: (filePath) => ipcRenderer.invoke("local-folder:read-file", filePath),
  onChanged: (callback) => onIpc("local-folder:changed", callback),
});
