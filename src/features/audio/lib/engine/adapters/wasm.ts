/**
 * engine/adapters/wasm.ts — ff_prot WASM 엔진 (native/ff_prot.c → Emscripten Node 빌드)
 *
 * adapters/native.ts(koffi FFI로 libirontune.so 로드, ELF x86-64 전용이라 macOS/Windows
 * 에서는 QEMU Docker 필요)와 달리, native/ff_prot.c를 WASM으로 컴파일한 산출물
 * (native/wasm/ff_prot.js, native/build-wasm.sh로 생성)을 Node의 WebAssembly 런타임
 * 안에서 직접 실행한다. 아키텍처 무관 — QEMU/--platform 지정이 필요 없다.
 *
 * ff_prot.c의 전역 상태(보이스코일 온도·LPF 상태)는 WASM 인스턴스의 선형 메모리에
 * 격리된다. openWasmSession()은 세션마다 새 모듈 인스턴스를 생성하므로
 * adapters/native.ts의 nativeLock(동시 1세션 제한)이 필요 없다.
 */

import type { EngineParams } from "../../../types";
import {
  SAMPLES_PER_CH, CHANNELS, BYTES_PER_SAMPLE, FRAME_BYTES,
  type FrameResult, type AnalysisSession, type MemoryLayout,
} from "../core";
import { logProtCall, logProtStop, logError } from "../logger";
import { createAnalysisFrame } from "../utils";

const AMB_TEMP = 25; // 주변 온도(°C) — ff_prot_start_exec 인자

/** WASM 엔진의 메모리 레이아웃 구현 */
class WasmMemoryLayout implements MemoryLayout {
  constructor(
    private mod: any,
    private bufPtr: number,
    private tempPtr: number,
    private excPtr: number,
  ) {}

  allocTemp() {
    return { tempPtr: this.tempPtr, excPtr: this.excPtr };
  }

  allocBuf() {
    return this.bufPtr;
  }

  writePlanar(bufPtr: number, planar: Int16Array) {
    this.mod.HEAP16.set(planar, bufPtr >> 1);
  }

  execAnalysis(bufPtr: number, tempPtr: number, excPtr: number) {
    this.mod._ff_prot_start_exec(
      bufPtr,
      SAMPLES_PER_CH,
      BYTES_PER_SAMPLE,
      CHANNELS,
      AMB_TEMP,
      tempPtr,
      excPtr,
    );
  }

  readResults(tempPtr: number, excPtr: number) {
    return [
      this.mod.HEAP32[tempPtr >> 2],
      this.mod.HEAP32[(tempPtr >> 2) + 1],
      this.mod.HEAP32[excPtr >> 2],
      this.mod.HEAP32[(excPtr >> 2) + 1],
    ] as [number, number, number, number];
  }

  free() {
    // free는 close에서 수행됨 (openWasmSession 내부에서 관리)
  }
}

// Emscripten MODULARIZE(ENVIRONMENT=node, SINGLE_FILE=1) 산출물: require()가 팩토리
// 함수를 반환하고, 팩토리를 호출할 때마다 독립된(선형 메모리가 분리된) 인스턴스가 생성된다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FfProtInstance = any;
let ffProtFactory: (() => Promise<FfProtInstance>) | null = null;
let ffProtFactoryPath: string | null = null;

function loadFactory(wasmPath: string): () => Promise<FfProtInstance> {
  if (ffProtFactory && ffProtFactoryPath === wasmPath) return ffProtFactory;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs");
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`ff_prot WASM 빌드 산출물 없음: ${wasmPath} (native/build-wasm.sh 로 생성)`);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  ffProtFactory = require(wasmPath);
  ffProtFactoryPath = wasmPath;
  return ffProtFactory as () => Promise<FfProtInstance>;
}

/**
 * WASM 세션을 열고 ff_prot_init / set_param까지 수행한 뒤 반환한다.
 * 세션마다 새 WASM 인스턴스를 생성하므로 adapters/native.ts와 달리 동시 세션 제한이 없다.
 */
export async function openWasmSession(wasmPath: string): Promise<AnalysisSession> {
  const factory = loadFactory(wasmPath);
  const mod: FfProtInstance = await factory();

  const bufPtr  = mod._malloc(FRAME_BYTES);
  const tempPtr = mod._malloc(CHANNELS * 4); // int32_t[2]
  const excPtr  = mod._malloc(CHANNELS * 4); // int32_t[2]

  let t0 = performance.now();
  const initRet = mod._ff_prot_init();
  logProtCall("ff_prot_init", initRet, performance.now() - t0);
  if (initRet !== 0) throw new Error(`ff_prot_init 실패 (ret=${initRet})`);

  t0 = performance.now();
  const paramRet = mod._ff_prot_set_param();
  logProtCall("ff_prot_set_param", paramRet, performance.now() - t0);
  if (paramRet !== 0) throw new Error(`ff_prot_set_param 실패 (ret=${paramRet})`);

  // ── 단일 프레임 분석 ──────────────────────────────────────────────────────
  const layout = new WasmMemoryLayout(mod, bufPtr, tempPtr, excPtr);
  const analyze = (pcm: Buffer, params: EngineParams): FrameResult => {
    return createAnalysisFrame(pcm, params, layout, true);
  };

  // ── 세션 종료: ff_prot_stop_exec + 힙 해제 ────────────────────────────────
  const close = (): void => {
    try {
      const t0c = performance.now();
      mod._ff_prot_stop_exec();
      logProtStop(performance.now() - t0c);
    } catch (err) {
      logError("ff_prot_stop_exec", err);
    } finally {
      mod._free(bufPtr);
      mod._free(tempPtr);
      mod._free(excPtr);
    }
  };

  return { analyze, close };
}
