// mime.ts — 확장자 → MIME 타입 매핑(AUDIO_MIME_TYPES).
// local_folder_read_file(Rust)은 raw 바이트만 돌려주므로(JSON과 바이너리를 한 번의 응답으로
// 못 돌려줌), mime 판정 책임이 shim으로 넘어온다 — 렌더러가 최종적으로 받는 형태는
// `{success, data: Uint8Array, mime}`다(계획서 5.5 참조).
const AUDIO_MIME_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".wma": "audio/x-ms-wma",
};

export function mimeForPath(filePath: string): string {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return "application/octet-stream";
  const ext = filePath.slice(dotIndex).toLowerCase();
  return AUDIO_MIME_TYPES[ext] ?? "application/octet-stream";
}
