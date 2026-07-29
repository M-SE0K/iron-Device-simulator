/**
 * mic-processor.js — AudioWorklet 프로세서
 *
 * AudioWorklet 컨텍스트(별도 스레드)에서 실행.
 * Web Audio API 기본 청크(128샘플)를 processorOptions.samplesPerCh 단위로 버퍼링한 뒤
 * 메인 스레드로 채널별 Float32 배열을 전송한다. (Calibration UI의 bufferSize/channels가 여기로 전달됨)
 * 채널 수는 고정 2(L/R)가 아니라 processorOptions.channels(요청한 캡처 채널 수, MCHStreamer 등
 * 멀티채널 인터페이스 대응)를 따르며, 실제로 들어오는 input 채널 수가 다르면 그쪽을 우선한다.
 */
const DEFAULT_SAMPLES_PER_CH = 480;
const DEFAULT_CHANNELS = 2;

class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedSamples = options?.processorOptions?.samplesPerCh;
    this._samplesPerCh = Number.isFinite(requestedSamples) && requestedSamples > 0
      ? requestedSamples
      : DEFAULT_SAMPLES_PER_CH;

    const requestedChannels = options?.processorOptions?.channels;
    this._channels = Number.isFinite(requestedChannels) && requestedChannels > 0
      ? requestedChannels
      : DEFAULT_CHANNELS;

    this._bufs   = Array.from({ length: this._channels }, () => new Float32Array(this._samplesPerCh));
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // 실측 입력 채널 수가 요청과 다르면(장치가 N채널을 못 줬을 때) 그쪽에 맞춰 버퍼를 다시 만든다.
    if (input.length !== this._bufs.length) {
      this._channels = input.length;
      this._bufs = Array.from({ length: this._channels }, () => new Float32Array(this._samplesPerCh));
      this._offset = 0;
    }

    const first = input[0] ?? new Float32Array(128);
    const blockLen = first.length;

    let pos = 0;
    while (pos < blockLen) {
      const space = this._samplesPerCh - this._offset;
      const copy  = Math.min(space, blockLen - pos);

      for (let ch = 0; ch < this._channels; ch++) {
        // 모노 소스에서 채널이 모자라면 ch0을 복제해 채운다.
        const src = input[ch] ?? first;
        this._bufs[ch].set(src.subarray(pos, pos + copy), this._offset);
      }
      this._offset += copy;
      pos          += copy;

      if (this._offset === this._samplesPerCh) {
        this.port.postMessage({ channels: this._bufs.map((b) => b.slice()) });
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
