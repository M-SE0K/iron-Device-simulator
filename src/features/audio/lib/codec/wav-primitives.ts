// WAV/RIFF 저수준 공용 헬퍼 — 완전 디코더(wav-decoder), 온디맨드 슬라이스 디코더
// (wav-incremental), 라이브 청크 뷰(ChartDetailOverlay)가 공유하는 태그 리더 + 샘플 리더.

/** RIFF 4바이트 청크 태그(예: "RIFF"/"WAVE"/"fmt "/"data")를 문자열로 읽는다. */
export function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * PCM/IEEE-float WAV 샘플을 [-1, 1) 범위 Float32로 읽는 리더를 만든다.
 * 지원: PCM(format 1) int16/int32, IEEE float(format 3) float32. 그 외는 null.
 * (기본 format=1 — bitsPerSample만 알아도 PCM 리더를 얻을 수 있다.)
 */
export function makeSampleReader(
  view: DataView,
  bitsPerSample: number,
  format: number = 1,
): ((byteOffset: number) => number) | null {
  if (format === 1 && bitsPerSample === 16) return (o) => view.getInt16(o, true) / 0x8000;
  if (format === 1 && bitsPerSample === 32) return (o) => view.getInt32(o, true) / 0x80000000;
  if (format === 3 && bitsPerSample === 32) return (o) => view.getFloat32(o, true);
  return null;
}
