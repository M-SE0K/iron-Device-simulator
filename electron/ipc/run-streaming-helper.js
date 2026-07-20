const { BrowserWindow } = require("electron");
const { spawn } = require("child_process");

function runStreamingHelper({
  event,
  helperPath,
  args,
  dataChannel,
  endedChannel,
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
        if (rest.length > 0 && !win.isDestroyed()) win.webContents.send(dataChannel, rest);
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

module.exports = { runStreamingHelper };
