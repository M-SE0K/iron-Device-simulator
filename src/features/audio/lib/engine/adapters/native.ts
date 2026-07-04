/**
 * engine/adapters/native.ts — libirontune.so 전용 엔진 (koffi FFI)
 *
 * ff_prot_* 함수 바인딩, 연결 생명주기(init / set_param / start_exec / stop_exec),
 * 전역 상태 보호용 nativeLock, de-interleave, 그리고 ff_prot_set_param이 NOP인
 * 동안의 파라미터 후처리 보정을 모두 캡슐화한다.
 *
 * libirontune.so는 ELF x86-64 바이너리 → macOS/Windows 로드 불가(Docker 필요).
 * 라이브러리가 전역 상태를 쓰므로 동시 native 세션은 1개로 제한한다(nativeLock).
 */

import type { EngineParams } from "../../../types";
import {
  SAMPLES_PER_CH, CHANNELS, BYTES_PER_SAMPLE, FRAME_BYTES,
  type FrameResult, type AnalysisSession, type MemoryLayout,
} from "../core";
import { logProtCall, logProtStop, logError } from "../logger";
import { createAnalysisFrame } from "../utils";

const AMB_TEMP = 25; // 주변 온도(°C) — ff_prot_start_exec 인자

/** 하위 호환성을 위한 alias (이전 코드가 NativeSession 타입을 사용한 경우) */
export type NativeSession = AnalysisSession;

/** native 엔진의 메모리 레이아웃 구현 */
class NativeMemoryLayout implements MemoryLayout {
  private planarStorage: Int16Array | null = null;

  constructor(private fnStartExec: (...args: unknown[]) => number) {}

  allocTemp() {
    return {
      tempPtr: Buffer.alloc(8) as unknown as number,
      excPtr: Buffer.alloc(8) as unknown as number,
    };
  }

  allocBuf() {
    // native는 PCM 버퍼 할당 필요 없음 (planar를 직접 전달)
    return 0;
  }

  writePlanar(_bufPtr: number, planar: Int16Array) {
    // native는 planar를 저장했다가 execAnalysis에서 사용
    this.planarStorage = planar;
  }

  execAnalysis(_bufPtr: number, tempPtr: number, excPtr: number) {
    if (!this.planarStorage) throw new Error("Planar data not set");
    this.fnStartExec(
      this.planarStorage,
      SAMPLES_PER_CH,
      BYTES_PER_SAMPLE,
      CHANNELS,
      AMB_TEMP,
      tempPtr,
      excPtr,
    );
  }

  readResults(tempPtr: number, excPtr: number) {
    const tempBuf = tempPtr as unknown as Buffer;
    const excBuf = excPtr as unknown as Buffer;
    return [
      tempBuf.readInt32LE(0),
      tempBuf.readInt32LE(4),
      excBuf.readInt32LE(0),
      excBuf.readInt32LE(4),
    ] as [number, number, number, number];
  }

  free() {
    // Buffer는 자동 GC
    this.planarStorage = null;
  }
}

// libirontune.so는 전역 상태 사용 가능 → 동시 연결 1개로 제한
let nativeLock = false;

/** native 라이브러리가 이미 사용 중인지 여부 */
export function isNativeLocked(): boolean {
  return nativeLock;
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
  const layout = new NativeMemoryLayout(fnStartExec);
  const analyze = (pcm: Buffer, params: EngineParams): FrameResult => {
    return createAnalysisFrame(pcm, params, layout, true);
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
