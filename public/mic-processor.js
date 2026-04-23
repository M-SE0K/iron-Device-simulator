/**
 * mic-processor.js — AudioWorklet 프로세서
 *
 * AudioWorklet 컨텍스트(별도 스레드)에서 실행.
 * Web Audio API 기본 청크(128샘플)를 480샘플 단위로 버퍼링한 뒤
 * 메인 스레드로 Float32 L/R 배열을 전송한다.
 */
const SAMPLES_PER_CH = 480;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufL   = new Float32Array(SAMPLES_PER_CH);
    this._bufR   = new Float32Array(SAMPLES_PER_CH);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const L = input[0] ?? new Float32Array(128);
    // 모노 마이크인 경우 L 채널을 R에 복제
    const R = input[1] ?? L;

    let pos = 0;
    while (pos < L.length) {
      const space = SAMPLES_PER_CH - this._offset;
      const copy  = Math.min(space, L.length - pos);

      this._bufL.set(L.subarray(pos, pos + copy), this._offset);
      this._bufR.set(R.subarray(pos, pos + copy), this._offset);
      this._offset += copy;
      pos          += copy;

      if (this._offset === SAMPLES_PER_CH) {
        this.port.postMessage({ L: this._bufL.slice(), R: this._bufR.slice() });
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
