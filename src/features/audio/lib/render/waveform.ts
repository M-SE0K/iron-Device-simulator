export interface WaveformWindow {
  startSec: number;
  data: Float32Array;
}

export function channelStats(data: Float32Array): { peak: number; rms: number } {
  let peak = 0, sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    sumSq += data[i] * data[i];
  }
  return { peak, rms: data.length ? Math.sqrt(sumSq / data.length) : 0 };
}
