import { CHANNELS, BYTES_PER_SAMPLE } from "@/features/audio/lib/engine/core";

const SENSING_CHANNEL_INDEX = { v: 2, i: 3 } as const;

export function createNativeFrameReframer(
  captureChannels: number,
  wireSamplesPerCh: number,
  onFrame: (frame: Int16Array) => void,
  onRawFrame?: (rawFrame: Int16Array) => void,
) {
  const bytesPerDeviceFrame = captureChannels * BYTES_PER_SAMPLE;
  let pending = new Uint8Array(0);
  const hasSensing = captureChannels > SENSING_CHANNEL_INDEX.i;
  const baseLen = wireSamplesPerCh * CHANNELS;
  const outPcm = new Int16Array(hasSensing ? baseLen + wireSamplesPerCh * 2 : baseLen);
  const outRaw = onRawFrame ? new Int16Array(wireSamplesPerCh * captureChannels) : null;
  let outCount = 0;

  return function reframe(chunk: Uint8Array): void {
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending);
    merged.set(chunk, pending.length);
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    let byteOff = 0;
    while (merged.length - byteOff >= bytesPerDeviceFrame) {
      outPcm[outCount * CHANNELS]     = view.getInt16(byteOff, true);
      outPcm[outCount * CHANNELS + 1] = view.getInt16(byteOff + BYTES_PER_SAMPLE, true);
      if (hasSensing) {
        outPcm[baseLen + outCount] =
          view.getInt16(byteOff + SENSING_CHANNEL_INDEX.v * BYTES_PER_SAMPLE, true);
        outPcm[baseLen + wireSamplesPerCh + outCount] =
          view.getInt16(byteOff + SENSING_CHANNEL_INDEX.i * BYTES_PER_SAMPLE, true);
      }
      if (outRaw) {
        for (let ch = 0; ch < captureChannels; ch++) {
          outRaw[outCount * captureChannels + ch] = view.getInt16(byteOff + ch * BYTES_PER_SAMPLE, true);
        }
      }
      outCount++;
      byteOff += bytesPerDeviceFrame;
      if (outCount === wireSamplesPerCh) {
        onFrame(outPcm);
        if (outRaw && onRawFrame) onRawFrame(outRaw);
        outCount = 0;
      }
    }
    pending = merged.slice(byteOff);
  };
}
