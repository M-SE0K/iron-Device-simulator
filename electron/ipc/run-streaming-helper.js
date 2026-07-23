const { BrowserWindow } = require("electron");
const { spawn } = require("child_process");

function runStreamingHelper({
  event,
  helperPath,
  args,
  dataChannel,
  endedChannel,
  // E2E 지연 실험(N1, src/features/audio/lib/perf-e2e/) 전용 — 넘겨지면 stdout 청크가 도착할
  // 때마다 실제 데이터와 별개로 { sentAt: Date.now() } 만 담은 가벼운 메시지를 같은 창에 추가로
  // 보낸다. 렌더러가 이 채널을 구독 중일 때만(opts.e2e) 호출측이 채널명을 넘기므로, 실험을 켜지
  // 않은 일반 사용에는 추가 IPC가 전혀 발생하지 않는다.
  markChannel,
  setChild,
  isCurrentChild,
  stopActiveChild,
  onChildError,
  onChildExit,
}) {
  const win = BrowserWindow.fromWebContents(event.sender);

  return new Promise((resolve) => {
    const child = spawn(helperPath, args);
    setChild(child);

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
        if (!win.isDestroyed()) win.webContents.send(dataChannel, chunk);
        if (markChannel && !win.isDestroyed()) win.webContents.send(markChannel, { sentAt: Date.now() });
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
        stopActiveChild();
      } else {
        const rest = headerBuf.subarray(nl + 1);
        if (rest.length > 0 && !win.isDestroyed()) {
          win.webContents.send(dataChannel, rest);
          if (markChannel) win.webContents.send(markChannel, { sentAt: Date.now() });
        }
      }
      settle(header);
    });

    child.on("error", (err) => {
      if (isCurrentChild(child)) setChild(null);
      onChildError?.(child);
      settle({ success: false, error: err.message });
    });

    child.on("exit", (code) => {
      onChildExit?.(child, code);
      if (isCurrentChild(child)) {
        setChild(null);
        if (!win.isDestroyed()) win.webContents.send(endedChannel, { code });
      }
      settle({ success: false, error: `helper-exited(${code})` });
    });
  });
}

// 상주 헬퍼 종료 — SIGTERM으로 바로 죽이면 Windows에서는 Node가 signal을 무시하고
// TerminateProcess로 즉시 강제 종료해, ASIOStop/DisposeBuffers/ASIOExit를 건너뛴다.
// 두 플랫폼 헬퍼 모두 stdin EOF를 이미 정상 종료 신호로 처리하므로(macOS: mac.swift의
// stdin availableData 감시, Windows: main.cpp의 stdinWatchLoop) stdin을 먼저 닫아 그 경로를
// 타게 하고, graceMs 안에 종료하지 않으면 kill()로 강제 정리한다(드라이버 행 등 안전망).
function stopStreamingChild(child, graceMs = 200) {
  if (child.exitCode !== null) return; // 이미 종료됨
  try {
    child.stdin.end();
  } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill();
  }, graceMs);
  child.once("exit", () => clearTimeout(timer));
}

module.exports = { runStreamingHelper, stopStreamingChild };
