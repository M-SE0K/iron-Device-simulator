/**
 * ws-engine.ts — WebSocket 연결 핸들러 (mock/native 디스패치)
 *
 * 메시지 프로토콜:
 *   Client→Server:  JSON { type: "init" | "pause" | "stop" | "metrics" }
 *                   Binary ArrayBuffer 1920 bytes (인터리브 PCM 프레임)
 *   Server→Client:  JSON { type: "ready" | "frame" | "error" }
 *
 * 분석 자체는 mock-engine(mockFrame) / native-engine(NativeSession)에 위임하고,
 * 이 파일은 연결 생명주기·프로토콜·로깅만 담당한다.
 *
 * 터미널 로그 제어 환경변수:
 *   LOG_FRAME_INTERVAL=N   N프레임마다 프레임 로그 출력 (기본 10, 0=전체)
 *   LOG_LEVEL=silent       프레임 로그 완전 억제
 */

import type WebSocket from "ws";
import type { WsServerMessage, EngineParams } from "../types";
import {
  logInitReceived, logReady,
  logFrame, logCtrl,
  logWsClose, logError, shouldLogFrame,
  logPipelineMetrics,
} from "./logger";
import { SAMPLE_RATE, SAMPLES_PER_CH, FRAME_BYTES } from "./engine-core";
import { mockFrame } from "./mock-engine";
import {
  openNativeSession, isNativeLocked,
  type NativeSession, type FrameResult,
} from "./native-engine";
import { openWasmSession } from "./wasm-engine";

// ENGINE=mock|native|wasm 이 우선이며, 미지정 시 기존 USE_MOCK 규약(하위 호환)을 따른다.
//   mock   — 물리 근사 시뮬레이션 (기본값)
//   native — libirontune.so(koffi FFI, ELF x86-64 전용, QEMU Docker 필요)
//   wasm   — native/ff_prot.c → WASM(Node 타깃) 빌드, 아키텍처 무관
type Engine = "mock" | "native" | "wasm";
const ENGINE: Engine = (() => {
  const raw = process.env.ENGINE;
  if (raw === "mock" || raw === "native" || raw === "wasm") return raw;
  return process.env.USE_MOCK === "false" ? "native" : "mock";
})();
const SO_PATH   = process.env.SO_PATH ?? "/app/native/libirontune.so";
const WASM_PATH = process.env.WASM_PATH ?? "/app/native/wasm/ff_prot.js";

// ─── WebSocket 연결 핸들러 ────────────────────────────────────────────────────
export function handleWsConnection(ws: WebSocket): void {
  let initialized = false;
  let frameCount  = 0;

  // 연결별 엔진 파라미터 (init 메시지에서 수신)
  let engineParams: EngineParams = { ampOutputPower: null, speakerModel: "" };
  // 실제 샘플레이트 (마이크 모드에서 48000 이외 값 가능)
  let connSampleRate: number = SAMPLE_RATE;

  // native/wasm 세션 (mock 모드에서는 항상 null)
  let session: NativeSession | null = null;

  const send = (msg: WsServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // ── cleanup: 세션 종료(ff_prot_stop_exec + 락/메모리 해제) ──────────────────
  const cleanup = (): void => {
    if (session) {
      session.close();
      session = null;
    }
    initialized = false;
    logWsClose();
  };

  // ── 메시지 수신 ─────────────────────────────────────────────────────────────
  ws.on("message", async (data: Buffer | string, isBinary: boolean) => {

    // ┌─ Binary: PCM 프레임 1920 bytes ─────────────────────────────────────────
    if (isBinary) {
      if (!initialized) return;

      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
      if (pcm.length < FRAME_BYTES) return;

      const currentFrame = frameCount;
      const time = parseFloat(((currentFrame * SAMPLES_PER_CH) / connSampleRate).toFixed(4));
      frameCount++;

      // 분석: native/wasm 세션이 있으면 그쪽, 없으면 mock
      let result: FrameResult;
      try {
        if (session) {
          result = session.analyze(pcm, engineParams);
        } else {
          const t0 = performance.now();
          const { temperature, excursion } = mockFrame(time, engineParams);
          result = { temperature, excursion, processingMs: parseFloat((performance.now() - t0).toFixed(3)) };
        }
      } catch (err) {
        logError("ff_prot_start_exec", err);
        send({ type: "error", message: `ff_prot_start_exec 오류: ${err}` });
        return;
      }

      const { temperature, excursion, processingMs } = result;
      send({ type: "frame", time, temperature, excursion, processingMs });

      if (shouldLogFrame(currentFrame)) {
        if (!session) {
          logFrame(currentFrame, processingMs, temperature[0], excursion[0], "mock");
          console.debug(
            `[ws-engine][mock] #${currentFrame}` +
            `  T=[${temperature[0].toFixed(1)}, ${temperature[1].toFixed(1)}]°C` +
            `  Exc=[${excursion[0].toFixed(2)}, ${excursion[1].toFixed(2)}]`
          );
        } else {
          const [rT0, rT1, rE0, rE1] = result.raw ?? [0, 0, 0, 0];
          logFrame(currentFrame, processingMs, temperature[0], excursion[0], ENGINE === "wasm" ? "wasm" : "native");
          console.debug(
            `[ws-engine][${ENGINE}] #${currentFrame}` +
            `  T=[${temperature[0]}, ${temperature[1]}]` +
            `  Exc=[${excursion[0]}, ${excursion[1]}]` +
            `  raw=[T0=${rT0} T1=${rT1} E0=${rE0} E1=${rE1}]`
          );
        }
      }
      return;
    }

    // ┌─ JSON 제어 메시지 ────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: { type: string } & Record<string, any>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // ── init ──────────────────────────────────────────────────────────────────
    if (msg.type === "init") {
      if (initialized) {
        send({ type: "ready" });
        return;
      }

      // 엔진 파라미터 파싱 (미설정 시 기본값 유지)
      const rawPower = parseFloat(msg.ampOutputPower);
      engineParams = {
        ampOutputPower: isFinite(rawPower) && rawPower > 0 ? rawPower : null,
        speakerModel:   typeof msg.speakerModel === "string" ? msg.speakerModel : "",
      };
      // 샘플레이트 (마이크 모드: 실제 값 전달, 파일 모드: 생략 → 기본값 48000)
      const rawRate = typeof msg.sampleRate === "number" ? msg.sampleRate : 0;
      connSampleRate = rawRate > 0 ? rawRate : SAMPLE_RATE;

      logInitReceived(ENGINE);

      if (ENGINE === "native") {
        if (isNativeLocked()) {
          send({ type: "error", message: "다른 세션이 라이브러리를 사용 중입니다. 잠시 후 다시 시도해주세요." });
          ws.close();
          return;
        }
        try {
          session = openNativeSession(SO_PATH);
        } catch (err) {
          logError("init", err);
          send({ type: "error", message: String(err) });
          return;
        }
      } else if (ENGINE === "wasm") {
        try {
          session = await openWasmSession(WASM_PATH);
        } catch (err) {
          logError("init", err);
          send({ type: "error", message: String(err) });
          return;
        }
      }

      initialized = true;
      frameCount  = 0;
      logReady();
      send({ type: "ready" });

    // ── metrics: 브라우저 렌더 파이프라인 역전송 ─────────────────────────────
    } else if (msg.type === "metrics") {
      logPipelineMetrics({
        frameIdx:          msg.frameIdx,
        audioTime:         msg.audioTime,
        rttMs:             msg.rttMs,
        serverProcMs:      msg.serverProcMs,
        reactRenderMs:     msg.reactRenderMs,
        echartsRenderMs:   msg.echartsRenderMs,
        totalRecvRenderMs: msg.totalRecvRenderMs,
        totalE2eMs:        msg.totalE2eMs,
      });

    // ── pause ─────────────────────────────────────────────────────────────────
    } else if (msg.type === "pause") {
      logCtrl("pause");

    // ── stop ──────────────────────────────────────────────────────────────────
    } else if (msg.type === "stop") {
      logCtrl("stop");
      cleanup();
      ws.close();
    }
  });

  ws.on("close", () => {
    if (initialized) cleanup();
    else logWsClose();
  });

  ws.on("error", (err) => {
    logError("WebSocket", err);
    cleanup();
  });
}
