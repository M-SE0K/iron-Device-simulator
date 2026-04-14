/**
 * ws-engine.ts — WebSocket 연결별 ff_prot 상태 관리
 *
 * 메시지 프로토콜:
 *   Client→Server:  JSON { type: "init" | "pause" | "stop" }
 *                   Binary ArrayBuffer 1024 bytes (인터리브 PCM 프레임)
 *   Server→Client:  JSON { type: "ready" | "frame" | "error" }
 *
 * 터미널 로그 제어 환경변수:
 *   LOG_FRAME_INTERVAL=N   N프레임마다 프레임 로그 출력 (기본 10, 0=전체)
 *   LOG_LEVEL=silent       프레임 로그 완전 억제
 */

import type WebSocket from "ws";
import type { WsServerMessage, EngineParams } from "./types";
import {
  logInitReceived, logProtCall, logReady,
  logFrame, logCtrl, logProtStop,
  logWsClose, logError, shouldLogFrame,
  logPipelineMetrics,
} from "./logger";

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

// ─── 스피커 프로파일 (so_report.md 기반 물리 모델) ───────────────────────────
// Native 모드: .so 출력에 후처리 스케일 적용 (ff_prot_set_param은 NOP이므로)
// Mock 모드  : tempBase / excAmp로 시뮬레이션 자체를 재구성
interface SpeakerProfile {
  tempMult: number;  // 온도 승수 (1.0 = 기준)
  excMult:  number;  // 익스커션 승수
  tempBase: number;  // mock 기준 온도 베이스 (°C)
  excAmp:   number;  // mock 기준 익스커션 최대 진폭 (mm)
}

const SPEAKER_PROFILES: Record<string, SpeakerProfile> = {
  // ISD-W4A: 4" 우퍼 기준 모델 (all ×1.0)
  "ISD-W4A": { tempMult: 1.00, excMult: 1.00, tempBase: 55, excAmp: 5.0 },
  // ISD-W6B: 6" 우퍼 — 진동판 면적 ↑ → 열 분산 ↑(온도↓), 변위 폭 ↑
  "ISD-W6B": { tempMult: 0.82, excMult: 1.30, tempBase: 50, excAmp: 6.5 },
  // ISD-T5C: 5" 미드/트위터 — 소형 → 열 집중(온도↑), 변위 제한(익스커션↓)
  "ISD-T5C": { tempMult: 1.22, excMult: 0.65, tempBase: 63, excAmp: 3.2 },
  // ISD-T8D: 8" 서브우퍼 — 대형 → 열 분산 ↑↑(온도↓), 최대 변위 ↑↑
  "ISD-T8D": { tempMult: 0.74, excMult: 1.52, tempBase: 47, excAmp: 7.8 },
};

const DEFAULT_PROFILE: SpeakerProfile = SPEAKER_PROFILES["ISD-W4A"];
const REF_AMP_POWER = 20; // W — 기준 전력

/** AMP 출력 전력 → 온도 승수 (열 평형: T ∝ P^0.6 근사) */
function powerTempMult(watt: number | null): number {
  if (watt === null || watt <= 0) return 1.0;
  return Math.pow(watt / REF_AMP_POWER, 0.6);
}

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

// ─── Mock 온도·익스커션 생성 (재생 시간 + 엔진 파라미터 기반) ───────────────
function mockFrame(time: number, params: EngineParams): { temperature: number; excursion: number } {
  const profile  = SPEAKER_PROFILES[params.speakerModel] ?? DEFAULT_PROFILE;
  const pwrScale = powerTempMult(params.ampOutputPower);

  // 온도: 모델 기준 베이스 + 파워에 비례한 상승폭, 재생 시간에 따라 완만한 사인 곡선
  const tempRise   = 15 * profile.tempMult * pwrScale;
  const temperature = parseFloat(
    (profile.tempBase * pwrScale + tempRise * Math.sin((time / 30) * Math.PI)
      + (Math.random() - 0.5) * 3).toFixed(2)
  );

  // 익스커션: 모델 기준 진폭, 오디오 파형 패턴 유지
  const excursion = parseFloat(
    (profile.excAmp * profile.excMult
      * Math.sin((time * 2 * Math.PI) / 0.8)
      * (0.7 + 0.3 * Math.sin(time * 0.4))
      + (Math.random() - 0.5) * 0.5).toFixed(3)
  );
  return { temperature, excursion };
}

// ─── WebSocket 연결 핸들러 ────────────────────────────────────────────────────
export function handleWsConnection(ws: WebSocket): void {
  let initialized = false;
  let frameCount  = 0;

  // 연결별 엔진 파라미터 (init 메시지에서 수신)
  let engineParams: EngineParams = { ampOutputPower: null, speakerModel: "" };

  // Native 엔진 함수 참조 (USE_MOCK=false 시 사용)
  let fnInit:      (() => number)                   | null = null;
  let fnSetParam:  (() => number)                   | null = null;
  let fnStartExec: ((...args: unknown[]) => number) | null = null;
  let fnStopExec:  (() => number)                   | null = null;

  const send = (msg: WsServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // ── cleanup: ff_prot 종료 + 락 해제 ────────────────────────────────────────
  const cleanup = (): void => {
    if (initialized && !USE_MOCK && fnStopExec) {
      try {
        const t0 = performance.now();
        fnStopExec();
        logProtStop(performance.now() - t0);
      } catch (err) {
        logError("ff_prot_stop_exec", err);
      }
    }
    initialized = false;
    if (!USE_MOCK) nativeLock = false;
    logWsClose();
  };

  // ── 메시지 수신 ─────────────────────────────────────────────────────────────
  ws.on("message", (data: Buffer | string, isBinary: boolean) => {

    // ┌─ Binary: PCM 프레임 1024 bytes ─────────────────────────────────────────
    if (isBinary) {
      if (!initialized) return;

      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
      if (pcm.length < FRAME_BYTES) return;

      const currentFrame = frameCount;
      const time = parseFloat(((currentFrame * SAMPLES_PER_CH) / SAMPLE_RATE).toFixed(4));
      frameCount++;

      const t0 = performance.now();

      if (USE_MOCK) {
        // ── Mock 경로 ──────────────────────────────────────────────────────────
        const { temperature, excursion } = mockFrame(time, engineParams);
        const processingMs = parseFloat((performance.now() - t0).toFixed(3));

        send({ type: "frame", time, temperature, excursion, processingMs });

        if (shouldLogFrame(currentFrame)) {
          logFrame(currentFrame, processingMs, temperature, excursion, "mock");
        }

      } else {
        // ── Native 경로 ────────────────────────────────────────────────────────
        // 1) de-interleave: LR LR LR → LL...RR...
        const planar     = deinterleave(pcm.subarray(0, FRAME_BYTES));

        // 2) ff_prot_start_exec 호출
        const spkTempBuf = Buffer.alloc(8); // int32_t[2]
        const spkExcBuf  = Buffer.alloc(8); // int32_t[2]

        try {
          fnStartExec!(planar, SAMPLES_PER_CH, BYTES_PER_SAMPLE, CHANNELS, AMB_TEMP, spkTempBuf, spkExcBuf);
        } catch (err) {
          logError("ff_prot_start_exec", err);
          send({ type: "error", message: `ff_prot_start_exec 오류: ${err}` });
          return;
        }

        // ff_prot_set_param은 NOP이므로 파라미터를 출력에 후처리 스케일로 적용
        // so_report.md §10 참고: K, Mms_x_K 등 전역변수 직접 주입 없이 스케일 근사
        const profile    = SPEAKER_PROFILES[engineParams.speakerModel] ?? DEFAULT_PROFILE;
        const pwrScale   = powerTempMult(engineParams.ampOutputPower);

        const rawTemp    = spkTempBuf.readInt32LE(0);
        const rawExc     = spkExcBuf.readInt32LE(0);
        const temperature = Math.round(rawTemp * profile.tempMult * pwrScale);
        const excursion   = Math.round(rawExc  * profile.excMult);
        const processingMs = parseFloat((performance.now() - t0).toFixed(3));

        send({ type: "frame", time, temperature, excursion, processingMs });

        if (shouldLogFrame(currentFrame)) {
          logFrame(currentFrame, processingMs, temperature, excursion, "native");
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

      const mode = USE_MOCK ? "mock" : "native";
      logInitReceived(mode);

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

          // ff_prot_init()
          let t0 = performance.now();
          const initRet = fnInit!();
          logProtCall("ff_prot_init", initRet, performance.now() - t0);
          if (initRet !== 0) throw new Error(`ff_prot_init 실패 (ret=${initRet})`);

          // ff_prot_set_param()
          t0 = performance.now();
          const paramRet = fnSetParam!();
          logProtCall("ff_prot_set_param", paramRet, performance.now() - t0);
          if (paramRet !== 0) throw new Error(`ff_prot_set_param 실패 (ret=${paramRet})`);

        } catch (err) {
          nativeLock = false;
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
