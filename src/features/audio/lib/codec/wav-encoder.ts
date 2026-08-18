import { CHANNELS, BYTES_PER_SAMPLE } from "../engine/core";

export function pcmFramesToWavBlob(
  frames: readonly (ArrayBuffer | Uint8Array<ArrayBuffer>)[],
  sampleRate: number,
  channels: number = CHANNELS,
): Blob {
  const dataSize    = frames.reduce((sum, f) => sum + f.byteLength, 0);
  const byteRate    = sampleRate * channels * BYTES_PER_SAMPLE;
  const blockAlign  = channels * BYTES_PER_SAMPLE;

  const header = new ArrayBuffer(44);
  const view   = new DataView(header);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([header, ...frames], { type: "audio/wav" });
}
