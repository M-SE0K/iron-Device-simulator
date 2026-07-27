const KNOWN_MESSAGES: Record<string, string> = {
  "unsupported-platform": "This feature isn't supported on your operating system.",
  "capture-already-running": "A capture session is already running.",
  "play-capture-already-running": "A playback/capture session is already running.",
  "invalid-helper-output": "The native audio helper returned an unexpected response.",
  "missing-ref-write-id": "The playback audio wasn't uploaded correctly.",
  "unknown-write-id": "The playback audio transfer session was lost — try again.",
  "device-has-no-output": "The selected device has no output channels.",
  "not-running": "No active capture session.",
  "no-folder-connected": "No folder is connected. Connect a folder first.",
  "invalid-path": "That file is outside the connected folder.",
};

const FS_ERRNO_MESSAGES: Record<string, string> = {
  ENOENT: "The file or folder couldn't be found — it may have been moved or deleted.",
  EACCES: "Permission denied while accessing the file or folder.",
  EPERM:  "Permission denied while accessing the file or folder.",
  EBUSY:  "The file is in use by another program.",
  EMFILE: "Too many files are open — try again.",
};

/**
 * Electron IPC/네이티브 헬퍼가 그대로 돌려주는 짧은 에러 코드(예: "capture-already-running")나
 * Node fs 에러 메시지(예: "ENOENT: no such file or directory, open '...'")를 사용자가 읽을 수
 * 있는 문장으로 바꾼다. 이미 사람이 쓴 문장(공백 포함)은 그대로 통과시키고, 알려지지 않은
 * 코드성 값만 원문을 노출하지 않고 `fallback`으로 대신하되 콘솔에는 원본을 남겨 디버깅은
 * 가능하게 한다.
 */
export function humanizeIpcError(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (KNOWN_MESSAGES[raw]) return KNOWN_MESSAGES[raw];
  if (/^helper-exited\(-?\d+\)$/.test(raw)) return "The native audio helper exited unexpectedly.";

  for (const [code, message] of Object.entries(FS_ERRNO_MESSAGES)) {
    if (raw.startsWith(code)) return message;
  }

  // 공백이 있으면 이미 사람이 작성한 문장(예: 앱 코드에서 직접 throw한 메시지)일 가능성이
  // 높다 — 그대로 보여준다. 공백 없는 짧은 코드성 문자열만 알 수 없는 IPC 코드로 취급한다.
  if (/\s/.test(raw)) return raw;

  console.warn(`[ipc] unrecognized error code: ${raw}`);
  return fallback;
}
