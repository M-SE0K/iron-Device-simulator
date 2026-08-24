import { humanizeIpcError } from "@/shared/lib/ipc-error";

const REF_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** play-capture --ref 재생 소스 업로드 핸드셰이크(startWrite → writeChunk×N → finalizeWrite).
 * 파일 재생(useNativeCapture)과 루프백 측정(lib/loopback/run.ts)이 같은 절차를 쓴다.
 * pcm은 인터리브 스테레오 Float32([L0,R0,...]) — 바이트 그대로 임시 파일이 되어 헬퍼가
 * Float32 배열로 다시 읽으므로(양쪽 다 리틀엔디언 타깃) 샘플이 비트 단위로 보존된다. */
export async function uploadPlaybackRef(
  bridge: NonNullable<Window["audioPlayCapture"]>,
  pcm: Float32Array,
): Promise<string> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const started = await bridge.startWrite({ totalBytes: bytes.byteLength });
  if (!started.success || !started.writeId) {
    throw new Error(humanizeIpcError(started.error, "Failed to start the playback file transfer."));
  }
  const { writeId } = started;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += REF_UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + REF_UPLOAD_CHUNK_BYTES, bytes.byteLength));
      const res = await bridge.writeChunk({ writeId, chunk });
      if (!res.success) throw new Error(humanizeIpcError(res.error, "Failed to transfer the playback file."));
    }
    const finalized = await bridge.finalizeWrite({ writeId });
    if (!finalized.success) throw new Error(humanizeIpcError(finalized.error, "Failed to finish the playback file transfer."));
  } catch (err) {
    bridge.cancelWrite({ writeId });
    throw err;
  }
  return writeId;
}
