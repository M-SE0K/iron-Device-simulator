/**
 * ws-engine.ts — WebSocket 연결별 ff_prot 상태 관리
 *
 * 메시지 프로토콜:
 *   Client→Server:  JSON { type: "init" | "pause" | "stop" }
 *                   Binary ArrayBuffer 1024 bytes (인터리브 PCM 프레임)
 *   Server→Client:  JSON { type: "ready" | "frame" | "error" }
 */

import type WebSocket from "ws";
import type { WsServerMessage } from "./types";

// ─── 처리 상수 ────────────────────────────────────────────────────────────────
const SAMPLE_RATE      = 44100;
const CHANNELS         = 2;
const BYTES_PER_SAMPLE = 2;
const SAMPLES_PER_CH   = 256;
const FRAME_BYTES      = SAMPLES_PER_CH * CHANNELS * BYTES_PER_SAMPLE; // 1024
const AMB_TEMP         = 25;
// ─────────────────────────────────────────────────────────────────────────────

const USE_MOCK = process.env.USE_MOCK !== "false";
const SO_PATH  = process.env.SO_PATH ?? "/app/native/libirontune.so";

// libirontune.so는 전역 상태 사용 가능 → 동시 연결 1개로 제한
let nativeLock = false;

// ─── PCM 변환: 인터리브(L R L R) → 플래너(LL...RR...) ───────────────────────
function deinterleave(src: Buffer): Buffer {
  const dst           = Buffer.alloc(src.length);
  const channelOffset = SAMPLES_PER_CH * BYTES_PER_SAMPLE; // 512
  const sampleStride  = CHANNELS * BYTES_PER_SAMPLE;        // 4

  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < SAMPLES_PER_CH; i++) {
      const srcOff = i * sampleStride + ch * BYTES_PER_SAMPLE;
      const dstOff = ch * channelOffset + i * BYTES_PER_SAMPLE;
      src.copy(dst, dstOff, srcOff, srcOff + BYTES_PER_SAMPLE);
    }
  }
  return dst;
}

// ─── Mock 온도·익스커션 생성 (재생 시간 기반) ─────────────────────────────────
function mockFrame(time: number): { temperature: number; excursion: number } {
  const temperature = parseFloat(
    (55 + 15 * Math.sin((time / 30) * Math.PI) + (Math.random() - 0.5) * 3).toFixed(2)
  );
  const excursion = parseFloat(
    (5 * Math.sin((time * 2 * Math.PI) / 0.8) * (0.7 + 0.3 * Math.sin(time * 0.4))
      + (Math.random() - 0.5) * 0.5).toFixed(3)
  );
  return { temperature, excursion };
}

// ─── WebSocket 연결 핸들러 ────────────────────────────────────────────────────
export function handleWsConnection(ws: WebSocket): void {
  let initialized  = false;
  let frameCount   = 0;

  // Native 엔진 함수 참조 (USE_MOCK=false 시 사용)
  let fnInit:      (() => number)                                     | null = null;
  let fnSetParam:  (() => number)                                     | null = null;
  let fnStartExec: ((...args: unknown[]) => number)                   | null = null;
  let fnStopExec:  (() => number)                                     | null = null;

  const send = (msg: WsServerMessage): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const cleanup = (): void => {
    if (initialized && !USE_MOCK && fnStopExec) {
      try { fnStopExec(); } catch { /* ignore */ }
    }
    initialized = false;
    if (!USE_MOCK) nativeLock = false;
  };

  // ── 메시지 수신 ────────────────────────────────────────────────────────────
  ws.on("message", (data: Buffer | string, isBinary: boolean) => {

    // ── Binary: PCM 프레임 1024 bytes ────────────────────────────────────────
    if (isBinary) {
      if (!initialized) return;

      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
      if (pcm.length < FRAME_BYTES) return;

      const time = parseFloat(((frameCount * SAMPLES_PER_CH) / SAMPLE_RATE).toFixed(4));
      frameCount++;

      const t0 = performance.now();

      if (USE_MOCK) {
        const { temperature, excursion } = mockFrame(time);
        const processingMs = parseFloat((performance.now() - t0).toFixed(3));
        send({ type: "frame", time, temperature, excursion, processingMs });
      } else {
        const planar     = deinterleave(pcm.subarray(0, FRAME_BYTES));
        const spkTempBuf = Buffer.alloc(8); // int32_t[2]
        const spkExcBuf  = Buffer.alloc(8); // int32_t[2]

        try {
          fnStartExec!(planar, SAMPLES_PER_CH, BYTES_PER_SAMPLE, CHANNELS, AMB_TEMP, spkTempBuf, spkExcBuf);
        } catch (err) {
          send({ type: "error", message: `ff_prot_start_exec 오류: ${err}` });
          return;
        }

        const temperature  = spkTempBuf.readInt32LE(0);
        const excursion    = spkExcBuf.readInt32LE(0);
        const processingMs = parseFloat((performance.now() - t0).toFixed(3));
        send({ type: "frame", time, temperature, excursion, processingMs });
      }
      return;
    }

    // ── JSON 제어 메시지 ──────────────────────────────────────────────────────
    let msg: { type: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "init") {
      if (initialized) {
        // 이미 초기화됨 → ready 재전송
        send({ type: "ready" });
        return;
      }

      if (!USE_MOCK) {
        if (nativeLock) {
          send({ type: "error", message: "다른 세션이 라이브러리를 사용 중입니다. 잠시 후 다시 시도해주세요." });
          ws.close();
          return;
        }
        nativeLock = true;

        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const koffi = require("koffi");
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs    = require("fs");

          if (!fs.existsSync(SO_PATH)) {
            throw new Error(`libirontune.so 파일 없음: ${SO_PATH}`);
          }

          const lib  = koffi.load(SO_PATH);
          fnInit      = lib.func("ff_prot_init",      "int", []);
          fnSetParam  = lib.func("ff_prot_set_param", "int", []);
          fnStopExec  = lib.func("ff_prot_stop_exec", "int", []);
          fnStartExec = lib.func(
            "ff_prot_start_exec", "int",
            ["void *", "uint32", "uint32", "uint32", "int32", "void *", "void *"]
          );

          const initRet  = fnInit!();
          if (initRet  !== 0) throw new Error(`ff_prot_init 실패 (ret=${initRet})`);
          const paramRet = fnSetParam!();
          if (paramRet !== 0) throw new Error(`ff_prot_set_param 실패 (ret=${paramRet})`);

        } catch (err) {
          nativeLock = false;
          send({ type: "error", message: String(err) });
          return;
        }
      }

      initialized = true;
      frameCount  = 0;
      console.log(`[ws-engine] 세션 초기화 완료 (mode=${USE_MOCK ? "mock" : "native"})`);
      send({ type: "ready" });

    } else if (msg.type === "pause") {
      // 일시정지: 서버 상태 유지, 프레임 전송만 중단 (클라이언트가 rAF 멈춤)
      console.log("[ws-engine] 일시정지");

    } else if (msg.type === "stop") {
      console.log("[ws-engine] 정지 — 세션 종료");
      cleanup();
      ws.close();
    }
  });

  ws.on("close", () => {
    console.log("[ws-engine] 연결 닫힘 — 정리");
    cleanup();
  });

  ws.on("error", (err) => {
    console.error("[ws-engine] WS 오류:", err);
    cleanup();
  });
}
