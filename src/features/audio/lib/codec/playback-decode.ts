export interface DecodedPlayback {
  /** 인터리브 스테레오 [L0,R0,L1,R1,...] — 모노 소스는 OfflineAudioContext가 L=R로 업믹스한다. */
  pcm: Float32Array;
  rate: number;
  duration: number;
}

// L/R 두 평면 채널을 [L0,R0,L1,R1,...] 인터리브 하나로 합친다 — 이 인터리브 포맷이 그대로
// play-capture 헬퍼의 --ref 파일 바이트가 된다(렌더러↔네이티브 헬퍼 간 청크 업로드 프로토콜은
// 무변경, 파일 내용의 의미만 모노→스테레오로 바뀐다).
function interleaveStereo(l: Float32Array, r: Float32Array): Float32Array {
  const out = new Float32Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    out[i * 2] = l[i];
    out[i * 2 + 1] = r[i];
  }
  return out;
}

export async function decodeFileToStereo(file: File, targetRate: number): Promise<DecodedPlayback> {
  const arrayBuf = await file.arrayBuffer();
  const probeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probeCtx.decodeAudioData(arrayBuf);
  } finally {
    void probeCtx.close();
  }
  const frames = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(2, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const pcm = interleaveStereo(rendered.getChannelData(0), rendered.getChannelData(1));
  return { pcm, rate: targetRate, duration: decoded.duration };
}
