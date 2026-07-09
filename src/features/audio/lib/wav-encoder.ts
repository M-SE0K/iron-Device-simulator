// 인터리브 Int32 PCM 프레임을 WAV Blob으로 인코딩한다.
//   · 파일 모드(WaveformPlayer): 엔진에 실제 전송한 2ch(V/I) 와이어 프레임 — 워크스페이스
//     "저장"이 원본 업로드 파일 대신 실제 분석된 데이터를 내보낼 수 있게 한다.
//   · 마이크 모드(useNativeCapture): Calibration에서 지정한 N채널 원본 캡처 버퍼 전체 —
//     엔진에 안 나간 ch2..chN-1도 버리지 않고 저장 요청 시 전 채널이 담긴다.
import { CHANNELS, BYTES_PER_SAMPLE } from "./engine/core";

/** 인터리브 Int32 PCM 프레임 배열 → 44바이트 표준 헤더를 가진 WAV Blob (기본 2ch=엔진 와이어 ABI) */
export function pcmFramesToWavBlob(
  frames: ArrayBuffer[],
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
  view.setUint32(16, 16, true);                        // fmt 청크 크기
  view.setUint16(20, 1, true);                          // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);       // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([header, ...frames], { type: "audio/wav" });
}
