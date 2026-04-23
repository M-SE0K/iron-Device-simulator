/**
 * ws-engine.ts — WebSocket 연결별 ff_prot 상태 관리
 *
 * 메시지 프로토콜:
 *   Client→Server:  JSON { type: "init" | "pause" | "stop" }
 *                   Binary ArrayBuffer 1920 bytes (인터리브 PCM 프레임)
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
const SAMPLE_RATE      = 48000;
const CHANNELS         = 2;
const BYTES_PER_SAMPLE = 2;
const SAMPLES_PER_CH   = 480;
const FRAME_BYTES      = SAMPLES_PER_CH * CHANNELS * BYTES_PER_SAMPLE; // 1920
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
  "Z3 SPK": { tempMult: 1.00, excMult: 1.00, tempBase: 55, excAmp: 5.0 },
  "PA3 SPK": { tempMult: 0.82, excMult: 1.30, tempBase: 50, excAmp: 6.5 },
  "B7 SPK": { tempMult: 1.22, excMult: 0.65, tempBase: 63, excAmp: 3.2 },
  "R8 SPK": { tempMult: 0.74, excMult: 1.52, tempBase: 47, excAmp: 7.8 },
};

const DEFAULT_PROFILE: SpeakerProfile = SPEAKER_PROFILES["Z3 SPK"];
const REF_AMP_POWER = 20; // W — 기준 전력

/** AMP 출력 전력 → 온도 승수 (열 평형: T ∝ P^0.6 근사) */
function powerTempMult(watt: number | null): number {
  if (watt === null || watt <= 0) return 1.0;
  return Math.pow(watt / REF_AMP_POWER, 0.6);
}

// ─── PCM 변환: 인터리브(L R L R) → 플래너(LL...RR...) ───────────────────────
function deinterleave(src: Buffer): Buffer {
  const dst           = Buffer.alloc(src.length);
  const channelOffset = SAMPLES_PER_CH * BYTES_PER_SAMPLE; // 960
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
function mockFrame(time: number, params: EngineParams): { temperature: [number, number]; excursion: [number, number] } {
  const profile  = SPEAKER_PROFILES[params.speakerModel] ?? DEFAULT_PROFILE;
  const pwrScale = powerTempMult(params.ampOutputPower);

  // 온도 ch0 (L) — 기준 모델 곡선
  const tempRise = 15 * profile.tempMult * pwrScale;
  const temp0 = parseFloat(
    (profile.tempBase * pwrScale + tempRise * Math.sin((time / 30) * Math.PI)
      + (Math.random() - 0.5) * 3).toFixed(2)
  );
  // 온도 ch1 (R) — 방열 환경 차이: 기준보다 약 8°C 높고 느리게 상승
  const temp1 = parseFloat(
    (profile.tempBase * pwrScale * 1.12 + tempRise * 0.85 * Math.sin((time / 38) * Math.PI)
      + (Math.random() - 0.5) * 3).toFixed(2)
  );

  // 익스커션 ch0 (L)
  const exc0 = parseFloat(
    (profile.excAmp * profile.excMult
      * Math.sin((time * 2 * Math.PI) / 0.8)
      * (0.7 + 0.3 * Math.sin(time * 0.4))
      + (Math.random() - 0.5) * 0.5).toFixed(3)
  );
  // 익스커션 ch1 (R) — 진폭 ×0.7, 위상 π/2 (90°) 차이로 명확히 구분
  const exc1 = parseFloat(
    (profile.excAmp * profile.excMult * 0.7
      * Math.sin((time * 2 * Math.PI) / 0.8 + Math.PI / 2)
      * (0.7 + 0.3 * Math.sin(time * 0.4 + 0.5))
      + (Math.random() - 0.5) * 0.5).toFixed(3)
  );
  return { temperature: [temp0, temp1], excursion: [exc0, exc1] };
}

// ─── WebSocket 연결 핸들러 ────────────────────────────────────────────────────
export function handleWsConnection(ws: WebSocket): void {
  let initialized = false;
  let frameCount  = 0;

  // 연결별 엔진 파라미터 (init 메시지에서 수신)
  let engineParams: EngineParams = { ampOutputPower: null, speakerModel: "" };
  // 실제 샘플레이트 (마이크 모드에서 48000 이외 값 가능)
  let connSampleRate: number = SAMPLE_RATE;

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

    // ┌─ Binary: PCM 프레임 1920 bytes ─────────────────────────────────────────
    if (isBinary) {
      if (!initialized) return;

      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
      if (pcm.length < FRAME_BYTES) return;

      const currentFrame = frameCount;
      const time = parseFloat(((currentFrame * SAMPLES_PER_CH) / connSampleRate).toFixed(4));
      frameCount++;

      const t0 = performance.now();

      if (USE_MOCK) {
        // ── Mock 경로 ──────────────────────────────────────────────────────────
        const { temperature, excursion } = mockFrame(time, engineParams);
        const processingMs = parseFloat((performance.now() - t0).toFixed(3));

        send({ type: "frame", time, temperature, excursion, processingMs });

        if (shouldLogFrame(currentFrame)) {
          logFrame(currentFrame, processingMs, temperature[0], excursion[0], "mock");
          console.debug(
            `[ws-engine][mock] #${currentFrame}` +
            `  T=[${temperature[0].toFixed(1)}, ${temperature[1].toFixed(1)}]°C` +
            `  Exc=[${excursion[0].toFixed(2)}, ${excursion[1].toFixed(2)}]`
          );
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

        // ff_prot_set_param은 NOP이므로 파라미터를 출력에 후처리 스케일로 적용 -> 추후 라이브러리 제공하면 수정 필요함.
        // so_report.md §10 참고: K, Mms_x_K 등 전역변수 직접 주입 없이 스케일 근사 -> 추후 라이브러리 제공하면 수정 필요함.
        const profile    = SPEAKER_PROFILES[engineParams.speakerModel] ?? DEFAULT_PROFILE;
        const pwrScale   = powerTempMult(engineParams.ampOutputPower);

        const rawTemp0 = spkTempBuf.readInt32LE(0);
        const rawTemp1 = spkTempBuf.readInt32LE(4);
        const rawExc0  = spkExcBuf.readInt32LE(0);
        const rawExc1  = spkExcBuf.readInt32LE(4);

        // libirontune.so는 현재 ch0만 결과를 씀 (ch1 = 0 고정)
        // → ch1이 0이고 ch0가 유효한 경우 ch0를 미러하여 사용
        // (향후 .so가 ch1도 출력하면 rawTemp1/rawExc1 자동 사용)
        const effectiveTemp1 = (rawTemp1 === 0 && rawTemp0 !== 0) ? rawTemp0 : rawTemp1;
        const effectiveExc1  = (rawExc1  === 0 && rawExc0  !== 0) ? rawExc0  : rawExc1;

        const temperature: [number, number] = [
          Math.round(rawTemp0      * profile.tempMult * pwrScale), // ch0(L)
          Math.round(effectiveTemp1 * profile.tempMult * pwrScale), // ch1(R) — 미러
        ];
        const excursion: [number, number] = [
          Math.round(rawExc0      * profile.excMult), // ch0(L)
          Math.round(effectiveExc1 * profile.excMult), // ch1(R) — 미러
        ];
        const processingMs = parseFloat((performance.now() - t0).toFixed(3));

        send({ type: "frame", time, temperature, excursion, processingMs });

        if (shouldLogFrame(currentFrame)) {
          logFrame(currentFrame, processingMs, temperature[0], excursion[0], "native");
          console.debug(
            `[ws-engine][native] #${currentFrame}` +
            `  T=[${temperature[0]}, ${temperature[1]}]` +
            `  Exc=[${excursion[0]}, ${excursion[1]}]` +
            `  raw=[T0=${rawTemp0} T1=${rawTemp1} E0=${rawExc0} E1=${rawExc1}]`
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
