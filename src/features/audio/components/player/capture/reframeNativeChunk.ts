/**
 * 네이티브 캡처 헬퍼가 보내는 N채널 인터리브 int16 청크를 wireSamplesPerCh 샘플
 * 프레임 단위로 재구성한다. device 버퍼가 wireSamplesPerCh와 다르거나 채널이 2가
 * 아니어도, 미완성 device-frame 잔여 바이트(pending)와 미완성 출력 프레임(outCount)을
 * 내부에 이월해 프레임 경계를 유지한다.
 *
 * 채널 의미(확정): ch0 = V(전압 센스), ch1 = I(전류 센스) — 이 두 채널만 엔진 분석
 * 프레임(onFrame)으로 나간다. 클라이언트가 Calibration에서 확장한 나머지 채널
 * (ch2..chN-1)은 버리지 않고, onRawFrame으로 N채널 인터리브 원본 그대로 방출해
 * 호출자가 세션 메모리에 보존했다가 저장 요청 시 전 채널을 내보낼 수 있게 한다.
 *
 * 실측 V/I sensing (2026-07-21 추가, sensingChannels): 장치가 4ch 이상이면 ch2/ch3를
 * ff_prot_start_exec의 v_sensing/i_sensing 실측 인자로 함께 실어 보낸다(⚠️ ch2=V/ch3=I는
 * 이 캡처 파이프라인의 잠정 컨벤션 — 실제 하드웨어 배선은 벤더/디바이스 문서로 확인 필요).
 * onFrame이 받는 버퍼 뒤에 [samples V][samples I]를 이어 붙인다 — local-socket.ts가
 * byteLength로 존재 여부를 판단해 분리한다(프로토콜 확장 없이 같은 바이너리 프레임에 얹는다).
 */
import { CHANNELS, BYTES_PER_SAMPLE } from "@/features/audio/lib/engine/core";

/** 실측 V/I sensing으로 쓸 원본 채널 인덱스 — captureChannels가 이 두 인덱스를 모두 포함해야 활성화된다. */
export const SENSING_CHANNEL_INDEX = { v: 2, i: 3 } as const;

export function createNativeFrameReframer(
  captureChannels: number,
  wireSamplesPerCh: number,
  onFrame: (frame: Int16Array) => void,
  onRawFrame?: (rawFrame: Int16Array) => void,
) {
  const bytesPerDeviceFrame = captureChannels * BYTES_PER_SAMPLE;
  let pending = new Uint8Array(0);
  const hasSensing = captureChannels > SENSING_CHANNEL_INDEX.i;
  const baseLen = wireSamplesPerCh * CHANNELS; // 2ch (V/I) — 기존 buf 규약, 변경 없음
  // sensing이 있으면 뒤에 [V samples][I samples](각 wireSamplesPerCh 길이, 모노)를 이어 붙인다.
  const outPcm = new Int16Array(hasSensing ? baseLen + wireSamplesPerCh * 2 : baseLen);
  // 전 채널 보존 버퍼 — onRawFrame을 쓰는 호출자가 있을 때만 채운다(동일 프레임 경계).
  const outRaw = onRawFrame ? new Int16Array(wireSamplesPerCh * captureChannels) : null;
  let outCount = 0; // 현재 채워진 출력 sample-frame 수

  return function reframe(chunk: Uint8Array): void {
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending);
    merged.set(chunk, pending.length);
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    let byteOff = 0;
    while (merged.length - byteOff >= bytesPerDeviceFrame) {
      outPcm[outCount * CHANNELS]     = view.getInt16(byteOff, true);                     // ch0 (V)
      outPcm[outCount * CHANNELS + 1] = view.getInt16(byteOff + BYTES_PER_SAMPLE, true);  // ch1 (I)
      if (hasSensing) {
        outPcm[baseLen + outCount] =
          view.getInt16(byteOff + SENSING_CHANNEL_INDEX.v * BYTES_PER_SAMPLE, true);
        outPcm[baseLen + wireSamplesPerCh + outCount] =
          view.getInt16(byteOff + SENSING_CHANNEL_INDEX.i * BYTES_PER_SAMPLE, true);
      }
      if (outRaw) {
        for (let ch = 0; ch < captureChannels; ch++) {
          outRaw[outCount * captureChannels + ch] = view.getInt16(byteOff + ch * BYTES_PER_SAMPLE, true);
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
