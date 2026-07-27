// electron/ipc/audio-playcapture.js — 파일 재생 + V/I 캡처 (상주형 play-capture 헬퍼).
//
// Electron 파일 모드의 재생/분석 경로. audio-capture.js의 상주 `capture`와 같은 스트리밍
// 프로토콜(첫 줄 JSON 헤더 → int16 인터리브 raw PCM 청크 중계)이지만, 헬퍼가 같은 IOProc의
// 출력 채널로 --ref 신호(렌더러가 재생 파일을 장치 SR로 디코드한 것 — 인터리브 스테레오
// [L0,R0,L1,R1,...], --ref-channels 2)를 --out-ch(L)/--out-ch-r(R)로 연속 재생한다 —
// 재생과 캡처가 단일 클록에 놓여 렌더러는 수신 프레임 수만으로 재생 위치를 안다. R은
// best-effort라 장치 출력이 1채널뿐이면 헬퍼가 조용히 모노로 폴백한다.
// ref 전달은 청크 핸드셰이크(start-write/write-chunk/finalize-write)다 — 파일 전체를 한 번의
// IPC 구조화 복제 + 동기 fs.writeFileSync로 넘기면(수 분 파일 기준 수십 MB) 싱글스레드 메인
// 프로세스가 그 순간 통째로 멎는다. 렌더러가 PCM을 작은 조각으로 잘라 순차 전송하고, 메인은
// fs.createWriteStream으로 받아써 이벤트 루프를 막지 않는다. 완성된 파일 경로는 writeId로
// 보관해뒀다가 start의 refWriteId로 소비한다.
// 제어는 헬퍼 stdin 라인 명령(pause/resume) — `audio-playcapture:control`이 중계한다.
// 헬퍼는 재생이 끝나면(+감쇠 테일) exit 0으로 스스로 종료한다: `audio-playcapture:ended`의
// code 0 = "재생 완료", 그 외 = 비정상 종료. 사용자 주도 stop은 child 참조를 먼저 비워
// ended 이벤트 자체를 억제한다(stopCapture 관례).
const { ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AUDIO_HELPER_PATH, SUPPORTED_PLATFORMS, withDevice } = require("./audio-device");
const { runStreamingHelper, stopStreamingChild } = require("./run-streaming-helper");

let playCaptureChild = null;
let writeSeq = 0;
// 진행 중인 청크 업로드: writeId -> { stream, path }
const writeSessions = new Map();
// finalize-write 완료, start 소비 대기 중인 ref 파일: writeId -> path
const finalizedRefs = new Map();

function stopPlayCapture() {
  if (!playCaptureChild) return { success: true };
  const child = playCaptureChild;
  playCaptureChild = null; // exit 핸들러가 "ended" 이벤트를 보내지 않도록 먼저 비운다 (사용자 주도 종료)
  stopStreamingChild(child);
  return { success: true };
}

// 렌더러가 재생 파일 PCM을 청크로 잘라 보내기 시작 — 임시 파일에 대한 쓰기 스트림을 연다.
ipcMain.handle("audio-playcapture:start-write", () => {
  const writeId = `${process.pid}-${writeSeq++}`;
  const refPath = path.join(os.tmpdir(), `iron-playcap-ref-${writeId}.f32`);
  const stream = fs.createWriteStream(refPath);
  writeSessions.set(writeId, { stream, path: refPath });
  return { success: true, writeId };
});

// 청크 하나를 스트림에 쓴다 — write()가 false(내부 버퍼 포화)면 drain까지 기다린 뒤 resolve해
// 렌더러의 순차 await 루프가 자연스러운 백프레셔를 갖게 한다.
ipcMain.handle("audio-playcapture:write-chunk", (_event, { writeId, chunk }) => {
  const session = writeSessions.get(writeId);
  if (!session) return { success: false, error: "unknown-write-id" };
  return new Promise((resolve) => {
    const buf = Buffer.from(chunk);
    let errored = false;
    const canContinue = session.stream.write(buf, (err) => {
      if (err && !errored) {
        errored = true;
        resolve({ success: false, error: err.message });
      }
    });
    if (errored) return;
    if (canContinue) resolve({ success: true });
    else session.stream.once("drain", () => resolve({ success: true }));
  });
});

// 마지막 청크 후 스트림을 닫고, 완성된 경로를 finalizedRefs로 옮긴다 — start가 그걸 소비한다.
ipcMain.handle("audio-playcapture:finalize-write", (_event, { writeId }) => {
  const session = writeSessions.get(writeId);
  if (!session) return { success: false, error: "unknown-write-id" };
  writeSessions.delete(writeId);
  return new Promise((resolve) => {
    session.stream.end((err) => {
      if (err) {
        fs.unlink(session.path, () => {});
        resolve({ success: false, error: err.message });
        return;
      }
      finalizedRefs.set(writeId, session.path);
      resolve({ success: true });
    });
  });
});

// 업로드 실패/재생 취소 시 진행 중이거나 완료된 세션을 정리해 임시 파일이 남지 않게 한다.
ipcMain.handle("audio-playcapture:cancel-write", (_event, { writeId }) => {
  const session = writeSessions.get(writeId);
  if (session) {
    writeSessions.delete(writeId);
    session.stream.destroy();
    fs.unlink(session.path, () => {});
  }
  const finalizedPath = finalizedRefs.get(writeId);
  if (finalizedPath) {
    finalizedRefs.delete(writeId);
    fs.unlink(finalizedPath, () => {});
  }
  return { success: true };
});

ipcMain.handle("audio-playcapture:start", (event, opts) => {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
    return { success: false, error: "unsupported-platform" };
  }
  if (playCaptureChild) {
    return { success: false, error: "play-capture-already-running" };
  }
  const { sampleRate, bufferSize, channels, deviceUID, refWriteId, refChannels, outputChannel, outputChannelR, e2e } = opts || {};
  const refPath = refWriteId ? finalizedRefs.get(refWriteId) : undefined;
  if (!refWriteId || !refPath) {
    return { success: false, error: "missing-ref-write-id" };
  }
  finalizedRefs.delete(refWriteId);
  const cleanupRef = () => fs.unlink(refPath, () => {});

  const baseArgs = ["play-capture", "--ref", refPath, String(sampleRate), String(bufferSize), String(channels || 2)];
  // ref 파일의 채널 수 — 2면 헬퍼가 인터리브 스테레오로 해석해 L/R을 분리한다. 생략 시 헬퍼 기본값(1=모노).
  if (refChannels != null) baseArgs.push("--ref-channels", String(refChannels));
  // 출력 채널 지정 — 생략/0이면 헬퍼 기본값(ch0)이라 굳이 안 붙여도 되지만, 명시적으로 넘겨
  // Calibration의 Output Channel 필드가 항상 실제 헬퍼 호출에 반영됨을 보장한다.
  if (outputChannel != null) baseArgs.push("--out-ch", String(outputChannel));
  // R 출력 채널 — 범위 밖/L과 중복이면 헬퍼가 에러 없이 모노로 폴백한다(리그가 항상 스테레오는 아니므로).
  if (outputChannelR != null) baseArgs.push("--out-ch-r", String(outputChannelR));

  return runStreamingHelper({
    event,
    helperPath: AUDIO_HELPER_PATH,
    args: withDevice(baseArgs, deviceUID),
    dataChannel: "audio-playcapture:data",
    endedChannel: "audio-playcapture:ended",
    // E2E 지연 실험(N1) 전용 — 렌더러가 명시적으로 요청했을 때만 채널명을 넘긴다.
    markChannel: e2e ? "audio-playcapture:e2e-mark" : undefined,
    setChild: (child) => { playCaptureChild = child; },
    isCurrentChild: (child) => playCaptureChild === child,
    stopActiveChild: stopPlayCapture,
    onChildError: cleanupRef,
    // 재생 완료(code 0) 포함 모든 종료 — ref 임시 파일은 어느 경로든 여기서 정리된다.
    onChildExit: cleanupRef,
  });
});

// pause/resume — 헬퍼 stdin 라인 명령으로 중계. stop은 별도 채널(아래)로 stdin EOF→유예→kill.
ipcMain.handle("audio-playcapture:control", (_event, { action }) => {
  if (!playCaptureChild) return { success: false, error: "not-running" };
  if (action !== "pause" && action !== "resume") {
    return { success: false, error: `unknown-action: ${action}` };
  }
  try {
    playCaptureChild.stdin.write(`${action}\n`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("audio-playcapture:stop", () => stopPlayCapture());

// main.js 앱 라이프사이클(window-all-closed/before-quit)이 호출해 자식 프로세스를 정리한다.
module.exports = { stopPlayCapture };
