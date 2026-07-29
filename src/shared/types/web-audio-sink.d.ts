// web-audio-sink.d.ts — Audio Output Devices API의 AudioContext 쪽 확장(setSinkId/sinkId).
// lib.dom.d.ts(TS 5.9.3)에는 HTMLMediaElement.setSinkId만 있고 AudioContext 쪽은 아직 없다.
// Chromium 계열에서만 지원되므로 항상 optional/feature-detect로 다룬다.
export {};

declare global {
  interface AudioContext {
    setSinkId?(sinkId: string | { type: "none" }): Promise<void>;
    readonly sinkId?: string;
  }
  interface AudioContextOptions {
    sinkId?: string | { type: "none" };
  }
}
