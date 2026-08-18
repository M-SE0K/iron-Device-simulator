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

export function humanizeIpcError(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (KNOWN_MESSAGES[raw]) return KNOWN_MESSAGES[raw];
  if (/^helper-exited\(-?\d+\)$/.test(raw)) return "The native audio helper exited unexpectedly.";

  for (const [code, message] of Object.entries(FS_ERRNO_MESSAGES)) {
    if (raw.startsWith(code)) return message;
  }

  if (/\s/.test(raw)) return raw;

  console.warn(`[ipc] unrecognized error code: ${raw}`);
  return fallback;
}
