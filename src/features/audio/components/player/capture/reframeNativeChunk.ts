/**
 * 네이티브 캡처 헬퍼가 보내는 N채널 인터리브 int16 청크를 ch0/ch1(L/R)
 * wireSamplesPerCh 샘플 프레임 단위로 재구성한다. device 버퍼가 wireSamplesPerCh와
 * 다르거나 채널이 2가 아니어도, 미완성 device-frame 잔여 바이트(pending)와 미완성
 * 출력 프레임(outCount)을 내부에 이월해 프레임 경계를 유지한다.
 */
export function createNativeFrameReframer(
  captureChannels: number,
  wireSamplesPerCh: number,
  onFrame: (frame: Int16Array) => void,
) {
  const bytesPerDeviceFrame = captureChannels * 2; // int16
  let pending = new Uint8Array(0);
  const outPcm = new Int16Array(wireSamplesPerCh * 2); // wireSamplesPerCh sample-frame × 2ch
  let outCount = 0; // 현재 채워진 출력 sample-frame 수

  return function reframe(chunk: Uint8Array): void {
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending);
    merged.set(chunk, pending.length);
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    let byteOff = 0;
    while (merged.length - byteOff >= bytesPerDeviceFrame) {
      outPcm[outCount * 2]     = view.getInt16(byteOff, true);     // ch0 (L)
      outPcm[outCount * 2 + 1] = view.getInt16(byteOff + 2, true); // ch1 (R)
      outCount++;
      byteOff += bytesPerDeviceFrame;
      if (outCount === wireSamplesPerCh) {
        onFrame(outPcm); // outPcm은 재사용되므로 호출자가 즉시 소비(복사)해야 한다
        outCount = 0;
      }
    }
    pending = merged.slice(byteOff);
  };
}
