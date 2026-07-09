/**
 * 네이티브 캡처 헬퍼가 보내는 N채널 인터리브 int32 청크를 wireSamplesPerCh 샘플
 * 프레임 단위로 재구성한다. device 버퍼가 wireSamplesPerCh와 다르거나 채널이 2가
 * 아니어도, 미완성 device-frame 잔여 바이트(pending)와 미완성 출력 프레임(outCount)을
 * 내부에 이월해 프레임 경계를 유지한다.
 *
 * 채널 의미(확정): ch0 = V(전압 센스), ch1 = I(전류 센스) — 이 두 채널만 엔진 분석
 * 프레임(onFrame)으로 나간다. 클라이언트가 Calibration에서 확장한 나머지 채널
 * (ch2..chN-1)은 버리지 않고, onRawFrame으로 N채널 인터리브 원본 그대로 방출해
 * 호출자가 세션 메모리에 보존했다가 저장 요청 시 전 채널을 내보낼 수 있게 한다.
 */
export function createNativeFrameReframer(
  captureChannels: number,
  wireSamplesPerCh: number,
  onFrame: (frame: Int32Array) => void,
  onRawFrame?: (rawFrame: Int32Array) => void,
) {
  const bytesPerDeviceFrame = captureChannels * 4; // int32
  let pending = new Uint8Array(0);
  const outPcm = new Int32Array(wireSamplesPerCh * 2); // wireSamplesPerCh sample-frame × 2ch (V/I)
  // 전 채널 보존 버퍼 — onRawFrame을 쓰는 호출자가 있을 때만 채운다(동일 프레임 경계).
  const outRaw = onRawFrame ? new Int32Array(wireSamplesPerCh * captureChannels) : null;
  let outCount = 0; // 현재 채워진 출력 sample-frame 수

  return function reframe(chunk: Uint8Array): void {
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending);
    merged.set(chunk, pending.length);
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    let byteOff = 0;
    while (merged.length - byteOff >= bytesPerDeviceFrame) {
      outPcm[outCount * 2]     = view.getInt32(byteOff, true);     // ch0 (V)
      outPcm[outCount * 2 + 1] = view.getInt32(byteOff + 4, true); // ch1 (I)
      if (outRaw) {
        for (let ch = 0; ch < captureChannels; ch++) {
          outRaw[outCount * captureChannels + ch] = view.getInt32(byteOff + ch * 4, true);
        }
      }
      outCount++;
      byteOff += bytesPerDeviceFrame;
      if (outCount === wireSamplesPerCh) {
        onFrame(outPcm); // outPcm/outRaw는 재사용되므로 호출자가 즉시 소비(복사)해야 한다
        if (outRaw && onRawFrame) onRawFrame(outRaw);
        outCount = 0;
      }
    }
    pending = merged.slice(byteOff);
  };
}
