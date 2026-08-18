import type { AnalysisFrame } from "@/features/audio/types";

const CHUNK_FRAMES = 65536;

export class FrameLog {
  private times: Float64Array[] = [];
  private temps: Float64Array[] = [];
  private excs: Float64Array[] = [];
  private count = 0;

  get length(): number {
    return this.count;
  }

  push(frame: AnalysisFrame): void {
    const offset = this.count % CHUNK_FRAMES;
    if (offset === 0) {
      this.times.push(new Float64Array(CHUNK_FRAMES));
      this.temps.push(new Float64Array(CHUNK_FRAMES));
      this.excs.push(new Float64Array(CHUNK_FRAMES));
    }
    const chunk = (this.count / CHUNK_FRAMES) | 0;
    this.times[chunk][offset] = frame.time;
    this.temps[chunk][offset] = frame.temperature;
    this.excs[chunk][offset] = frame.excursion;
    this.count++;
  }

  clear(): void {
    this.times = [];
    this.temps = [];
    this.excs = [];
    this.count = 0;
  }

  toFrames(): AnalysisFrame[] {
    const out: AnalysisFrame[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const chunk = (i / CHUNK_FRAMES) | 0;
      const offset = i % CHUNK_FRAMES;
      out[i] = {
        time: this.times[chunk][offset],
        temperature: this.temps[chunk][offset],
        excursion: this.excs[chunk][offset],
      };
    }
    return out;
  }
}
