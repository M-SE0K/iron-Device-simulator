import { BYTES_PER_SAMPLE } from "@/features/audio/lib/engine/core";

const REST_SLAB_BYTES = 16 * 1024 * 1024;
const MAX_FIRST_SLAB_BYTES = 256 * 1024 * 1024;

export class PcmFrameStore {
  readonly channels: number;
  readonly sampleRate: number;
  readonly samplesPerFrame: number;

  private readonly stride: number;
  private readonly firstSlabFrames: number;
  private readonly restSlabFrames: number;
  private readonly slabs: Int16Array<ArrayBuffer>[] = [];
  private count = 0;

  constructor(opts: {
    channels: number;
    sampleRate: number;
    samplesPerFrame: number;
    expectedFrames?: number;
  }) {
    this.channels = opts.channels;
    this.sampleRate = opts.sampleRate;
    this.samplesPerFrame = opts.samplesPerFrame;
    this.stride = opts.samplesPerFrame * opts.channels;

    const bytesPerFrame = this.stride * BYTES_PER_SAMPLE;
    this.restSlabFrames = Math.max(1, Math.floor(REST_SLAB_BYTES / bytesPerFrame));
    const maxFirst = Math.max(1, Math.floor(MAX_FIRST_SLAB_BYTES / bytesPerFrame));
    this.firstSlabFrames = opts.expectedFrames != null && opts.expectedFrames > 0
      ? Math.min(opts.expectedFrames, maxFirst)
      : this.restSlabFrames;
  }

  get frameCount(): number {
    return this.count;
  }

  get totalSamples(): number {
    return this.count * this.samplesPerFrame;
  }

  frame(i: number): Int16Array {
    const [slab, offset] = this.locate(i);
    const start = offset * this.stride;
    return this.slabs[slab].subarray(start, start + this.stride);
  }

  /** 프레임 i 부터 같은 슬랩 안에서 연속된 프레임들을 한 뷰로 돌려준다 —
   * 벌크 소비자(pcm-kit 백필 등)가 프레임 단위 대신 런 단위로 읽기 위한 접근자. */
  frameRun(i: number, maxFrames: number): { view: Int16Array; frames: number } {
    const [slab, offset] = this.locate(i);
    const frames = Math.max(0, Math.min(maxFrames, this.count - i, this.capacityOf(slab) - offset));
    const start = offset * this.stride;
    return { view: this.slabs[slab].subarray(start, start + frames * this.stride), frames };
  }

  append(src: Int16Array): Int16Array {
    this.ensure(this.count + 1);
    const view = this.frame(this.count);
    view.set(src.length <= this.stride ? src : src.subarray(0, this.stride));
    this.count++;
    return view;
  }

  appendSilence(n: number): void {
    if (n <= 0) return;
    this.ensure(this.count + n);
    this.count += n;
  }

  byteChunks(): Uint8Array<ArrayBuffer>[] {
    const out: Uint8Array<ArrayBuffer>[] = [];
    let remaining = this.count;
    for (let i = 0; i < this.slabs.length && remaining > 0; i++) {
      const used = Math.min(remaining, this.capacityOf(i));
      out.push(new Uint8Array(this.slabs[i].buffer, 0, used * this.stride * BYTES_PER_SAMPLE));
      remaining -= used;
    }
    return out;
  }

  private capacityOf(slab: number): number {
    return slab === 0 ? this.firstSlabFrames : this.restSlabFrames;
  }

  private locate(frame: number): [number, number] {
    if (frame < this.firstSlabFrames) return [0, frame];
    const rest = frame - this.firstSlabFrames;
    return [1 + Math.floor(rest / this.restSlabFrames), rest % this.restSlabFrames];
  }

  private ensure(frames: number): void {
    const [lastSlab] = this.locate(frames - 1);
    while (this.slabs.length <= lastSlab) {
      this.slabs.push(new Int16Array(this.capacityOf(this.slabs.length) * this.stride));
    }
  }
}
