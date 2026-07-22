import { INT16_SCALE } from "@/features/audio/lib/engine/core";

export function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function makeSampleReader(
  view: DataView,
  bitsPerSample: number,
  format: number = 1,
): ((byteOffset: number) => number) | null {
  if (format === 1 && bitsPerSample === 16) return (o) => view.getInt16(o, true) / INT16_SCALE;
  if (format === 1 && bitsPerSample === 32) return (o) => view.getInt32(o, true) / 0x80000000;
  if (format === 3 && bitsPerSample === 32) return (o) => view.getFloat32(o, true);
  return null;
}
