import { BYTES_PER_SAMPLE } from "@/features/audio/lib/engine/core";

/* 헬퍼는 int16을 네이티브 엔디언으로 쓰고 릴레이(streaming.rs)는 바이트를 그대로 전달한다.
 * 지원 타깃(macOS arm64/x86_64, Windows x64)은 전부 리틀엔디언이라 reframeNativeChunk도
 * LE 고정으로 읽는다 — 여기서는 만약을 위해 호스트 엔디언을 1회 확인해 BE면 느린 경로로 간다. */
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** 캡처 바이트 싱크 — play-capture stdout 릴레이 청크(임의 크기)를 무손실 누적한다.
 * 프레임 수는 오직 누적 바이트 ÷ (2·채널) 로만 계산한다(콜백 횟수·벽시계 비개입).
 * 검출 위치의 절대 인덱스가 곧 지연값이므로, 단 1바이트의 유실/중복도 결과를 어긋나게
 * 한다 — trailingBytes 가 세션 종료 시 0인지가 무결성 판정 항목이다. */
export class CaptureByteSink {
  private parts: Uint8Array[] = [];
  private total = 0;

  push(chunk: Uint8Array): void {
    this.parts.push(chunk);
    this.total += chunk.byteLength;
  }

  get totalBytes(): number {
    return this.total;
  }

  frameCount(channels: number): number {
    return Math.floor(this.total / (BYTES_PER_SAMPLE * channels));
  }

  trailingBytes(channels: number): number {
    return this.total % (BYTES_PER_SAMPLE * channels);
  }

  /** 전체 스트림을 int16 LE 인터리브로 해석해 하나의 Int16Array로 병합한다. */
  toInt16(): Int16Array {
    const sampleCount = Math.floor(this.total / BYTES_PER_SAMPLE);
    const merged = new Uint8Array(sampleCount * BYTES_PER_SAMPLE);
    let offset = 0;
    for (const part of this.parts) {
      const room = merged.byteLength - offset;
      if (room <= 0) break;
      merged.set(room >= part.byteLength ? part : part.subarray(0, room), offset);
      offset += Math.min(room, part.byteLength);
    }
    if (HOST_IS_LITTLE_ENDIAN) {
      return new Int16Array(merged.buffer, 0, sampleCount);
    }
    const view = new DataView(merged.buffer);
    const out = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) out[i] = view.getInt16(i * BYTES_PER_SAMPLE, true);
    return out;
  }
}
