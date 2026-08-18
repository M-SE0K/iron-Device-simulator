export interface DecodedPlayback {
  pcm: Float32Array;
  rate: number;
  duration: number;
}

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
