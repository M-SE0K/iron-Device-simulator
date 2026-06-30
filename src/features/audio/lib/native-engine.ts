/**
 * native-engine.ts — libirontune.so 전용 엔진 (koffi FFI)
 *
 * ff_prot_* 함수 바인딩, 연결 생명주기(init / set_param / start_exec / stop_exec),
 * 전역 상태 보호용 nativeLock, de-interleave, 그리고 ff_prot_set_param이 NOP인
 * 동안의 파라미터 후처리 보정을 모두 캡슐화한다.
 *
 * libirontune.so는 ELF x86-64 바이너리 → macOS/Windows 로드 불가(Docker 필요).
 * 라이브러리가 전역 상태를 쓰므로 동시 native 세션은 1개로 제한한다(nativeLock).
 */

import type { EngineParams } from "../types";
import {
  SAMPLES_PER_CH, CHANNELS, BYTES_PER_SAMPLE, FRAME_BYTES,
  SPEAKER_PROFILES, DEFAULT_PROFILE, powerTempMult,
} from "./engine-core";
import { logProtCall, logProtStop, logError } from "./logger";

const AMB_TEMP = 25; // 주변 온도(°C) — ff_prot_start_exec 인자

export interface FrameResult {
  temperature:  [number, number];
  excursion:    [number, number];
  processingMs: number;
  /** native 디버그용 raw 값 [T0, T1, E0, E1] */
  raw?: [number, number, number, number];
}

/** 단일 native 세션 (1 WS 연결 = 1 세션) */
export interface NativeSession {
  /** PCM 프레임 1개 분석 (deinterleave + ff_prot_start_exec + 후처리 보정) */
  analyze(pcm: Buffer, params: EngineParams): FrameResult;
  /** ff_prot_stop_exec + 락 해제 */
  close(): void;
}

// libirontune.so는 전역 상태 사용 가능 → 동시 연결 1개로 제한
let nativeLock = false;

/** native 라이브러리가 이미 사용 중인지 여부 */
export function isNativeLocked(): boolean {
  return nativeLock;
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

/**
 * libirontune.so를 로드하고 ff_prot_init / set_param까지 수행한 뒤 세션을 반환한다.
 * 이미 다른 세션이 사용 중(lock)이거나 로드/초기화에 실패하면 예외를 던진다
 * (실패 시 락은 자동 해제).
 */
export function openNativeSession(soPath: string): NativeSession {
  if (nativeLock) {
    throw new Error("다른 세션이 라이브러리를 사용 중입니다. 잠시 후 다시 시도해주세요.");
  }
  nativeLock = true;

  let fnStartExec: (...args: unknown[]) => number;
  let fnStopExec:  () => number;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs    = require("fs");

    if (!fs.existsSync(soPath)) {
      throw new Error(`libirontune.so 파일 없음: ${soPath}`);
    }

    const lib        = koffi.load(soPath);
    const fnInit     = lib.func("ff_prot_init",      "int", []);
    const fnSetParam = lib.func("ff_prot_set_param", "int", []);
    fnStopExec       = lib.func("ff_prot_stop_exec", "int", []);
    fnStartExec      = lib.func(
      "ff_prot_start_exec", "int",
      ["void *", "uint32", "uint32", "uint32", "int32", "void *", "void *"]
    );

    // ff_prot_init()
    let t0 = performance.now();
    const initRet = fnInit();
    logProtCall("ff_prot_init", initRet, performance.now() - t0);
    if (initRet !== 0) throw new Error(`ff_prot_init 실패 (ret=${initRet})`);

    // ff_prot_set_param()
    t0 = performance.now();
    const paramRet = fnSetParam();
    logProtCall("ff_prot_set_param", paramRet, performance.now() - t0);
    if (paramRet !== 0) throw new Error(`ff_prot_set_param 실패 (ret=${paramRet})`);
  } catch (err) {
    nativeLock = false;
    throw err;
  }

  // ── 단일 프레임 분석 ──────────────────────────────────────────────────────
  const analyze = (pcm: Buffer, params: EngineParams): FrameResult => {
    const t0 = performance.now();

    // 1) de-interleave: LR LR LR → LL...RR...
    const planar     = deinterleave(pcm.subarray(0, FRAME_BYTES));
    const spkTempBuf = Buffer.alloc(8); // int32_t[2]
    const spkExcBuf  = Buffer.alloc(8); // int32_t[2]

    // 2) ff_prot_start_exec 호출 (예외는 호출자에서 처리)
    fnStartExec(planar, SAMPLES_PER_CH, BYTES_PER_SAMPLE, CHANNELS, AMB_TEMP, spkTempBuf, spkExcBuf);

    // ff_prot_set_param은 NOP이므로 파라미터를 출력에 후처리 스케일로 적용 -> 추후 라이브러리 제공하면 수정 필요함.
    // so_report.md §10 참고: K, Mms_x_K 등 전역변수 직접 주입 없이 스케일 근사 -> 추후 라이브러리 제공하면 수정 필요함.
    const profile  = SPEAKER_PROFILES[params.speakerModel] ?? DEFAULT_PROFILE;
    const pwrScale = powerTempMult(params.ampOutputPower);

    const rawTemp0 = spkTempBuf.readInt32LE(0);
    const rawTemp1 = spkTempBuf.readInt32LE(4);
    const rawExc0  = spkExcBuf.readInt32LE(0);
    const rawExc1  = spkExcBuf.readInt32LE(4);

    const temperature: [number, number] = [
      Math.round(rawTemp0 * profile.tempMult * pwrScale),
      Math.round(rawTemp1 * profile.tempMult * pwrScale),
    ];
    const excursion: [number, number] = [
      Math.round(rawExc0 * profile.excMult),
      Math.round(rawExc1 * profile.excMult),
    ];

    return {
      temperature,
      excursion,
      processingMs: parseFloat((performance.now() - t0).toFixed(3)),
      raw: [rawTemp0, rawTemp1, rawExc0, rawExc1],
    };
  };

  // ── 세션 종료: ff_prot_stop_exec + 락 해제 ────────────────────────────────
  const close = (): void => {
    try {
      const t0 = performance.now();
      fnStopExec();
      logProtStop(performance.now() - t0);
    } catch (err) {
      logError("ff_prot_stop_exec", err);
    } finally {
      nativeLock = false;
    }
  };

  return { analyze, close };
}
