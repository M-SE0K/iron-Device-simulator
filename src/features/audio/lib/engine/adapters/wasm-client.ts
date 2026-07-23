import type { EngineParams } from "../../../types";
import {
  CHANNELS, BYTES_PER_SAMPLE, frameBytes, DEFAULT_ENGINE_CONFIG,
  type FrameResult, type AnalysisSession, type MemoryLayout, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import { createAnalysisFrame, type AnalysisFrameOptions } from "../utils";

class ClientWasmMemoryLayout implements MemoryLayout {
  constructor(
    private mod: FfProtInstance,
    private bufPtr: number,
    private tempPtr: number,
    private excPtr: number,
    private config: EngineRuntimeConfig,
    private vSensingPtr: number,
    private iSensingPtr: number,
  ) {}

  private execFailures = 0;
  private firstFailureCode: number | null = null;

  private debugFrame = 0;

  allocTemp() {
    return { tempPtr: this.tempPtr, excPtr: this.excPtr };
  }

  allocBuf() {
    return this.bufPtr;
  }

  writePlanar(bufPtr: number, planar: Int16Array) {
    this.mod.HEAP16.set(planar, bufPtr >> 1);
  }

  execAnalysis(bufPtr: number, tempPtr: number, excPtr: number, ambientTemp: number, sensing?: RealSensingPair) {
    let vArg = 0;
    let iArg = 0;
    if (sensing) {
      this.mod.HEAP16.set(sensing.v, this.vSensingPtr >> 1);
      this.mod.HEAP16.set(sensing.i, this.iSensingPtr >> 1);
      vArg = this.vSensingPtr;
      iArg = this.iSensingPtr;
    }

    this.debugFrame++;
    if (this.debugFrame % 10 === 0) {
      console.log(
        `[sensing-debug] wasm-client frame=${this.debugFrame} sensing=${!!sensing} ` +
        `vArg=${vArg} iArg=${iArg} ` +
        `in.v[0]=${sensing?.v[0]} in.i[0]=${sensing?.i[0]} ` +
        `heapEcho.v[0]=${vArg ? this.mod.HEAP16[vArg >> 1] : "n/a"} ` +
        `heapEcho.i[0]=${iArg ? this.mod.HEAP16[iArg >> 1] : "n/a"}`,
      );
    }

    const ret = this.mod._ff_prot_start_exec(
      bufPtr,
      this.config.samplesPerCh,
      BYTES_PER_SAMPLE,
      CHANNELS,
      ambientTemp,
      tempPtr,
      excPtr,
      vArg,
      iArg,
    );

    if (ret !== 0) {
      if (this.execFailures === 0) {
        this.firstFailureCode = ret;
        console.warn(
          `ff_prot_start_exec 실패 (ret=${ret}) — 이 프레임의 온도/변위는 직전 값이 유지됩니다. ` +
          "이후 동일 오류는 집계만 하고 세션은 유지합니다.",
        );
      }
      this.execFailures++;
    }
  }

  get failureStats(): { count: number; firstCode: number | null } {
    return { count: this.execFailures, firstCode: this.firstFailureCode };
  }

  readProcessedPcm(bufPtr: number, samplesPerCh: number): Int16Array {
    const start = bufPtr >> 1;
    return this.mod.HEAP16.slice(start, start + samplesPerCh * CHANNELS);
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
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FfProtInstance = any;
type FfProtFactory = (moduleArg?: Record<string, unknown>) => Promise<FfProtInstance>;

// 기본은 클린 WASM(public/wasm/, 프로덕션·측정 공용). 실험(debug) 빌드(npm run wasm:build:debug →
// public/wasm-debug/, V/I 값 printf 덤프 포함)를 쓰려면 빌드/dev 서버 기동 시
// NEXT_PUBLIC_WASM_DIR=/wasm-debug 를 설정한다 — scripts/build/build-static-local.sh의
// WASM_MODE=debug 가 이 값을 자동으로 맞춰준다.
const WASM_DIR = process.env.NEXT_PUBLIC_WASM_DIR || "/wasm";

let factoryPromise: Promise<FfProtFactory> | null = null;

function loadFactory(): Promise<FfProtFactory> {
  if (factoryPromise) return factoryPromise;

  factoryPromise = new Promise((resolve, reject) => {
    const g = globalThis as unknown as { FfProtModule?: FfProtFactory };
    if (g.FfProtModule) {
      resolve(g.FfProtModule);
      return;
    }

    const importScriptsFn = (globalThis as unknown as {
      importScripts?: (...urls: string[]) => void;
    }).importScripts;
    if (typeof importScriptsFn === "function") {
      try {
        importScriptsFn(`${WASM_DIR}/ff_prot.js`);
      } catch (err) {
        reject(new Error(`${WASM_DIR}/ff_prot.js importScripts 실패: ${err}`));
        return;
      }
      const factory = (globalThis as unknown as { FfProtModule?: FfProtFactory }).FfProtModule;
      if (!factory) {
        reject(new Error("FfProtModule을 찾을 수 없습니다 (worker importScripts 후 전역 없음)."));
        return;
      }
      resolve(factory);
      return;
    }

    if (typeof document === "undefined") {
      reject(new Error("wasm-client-engine은 브라우저 메인 스레드 또는 Web Worker 전용입니다."));
      return;
    }
    const script = document.createElement("script");
    script.src = `${WASM_DIR}/ff_prot.js`;
    script.onload = () => {
      const factory = (globalThis as unknown as { FfProtModule?: FfProtFactory }).FfProtModule;
      if (!factory) {
        reject(new Error("FfProtModule을 찾을 수 없습니다 (wasm 스크립트 로드 실패)."));
        return;
      }
      resolve(factory);
    };
    script.onerror = () => reject(new Error(`${WASM_DIR}/ff_prot.js 로드 실패`));
    document.head.appendChild(script);
  });

  return factoryPromise;
}


export async function openClientWasmSession(
  config: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG,
  opts: AnalysisFrameOptions = {},
): Promise<AnalysisSession> {
  const factory = await loadFactory();
  const mod: FfProtInstance = await factory({ locateFile: (path: string) => `${WASM_DIR}/${path}` });

  const bufPtr  = mod._malloc(frameBytes(config));
  const tempPtr = mod._malloc(CHANNELS * 4);
  const excPtr  = mod._malloc(CHANNELS * 4);
  const vSensingPtr = mod._malloc(config.samplesPerCh * BYTES_PER_SAMPLE);
  const iSensingPtr = mod._malloc(config.samplesPerCh * BYTES_PER_SAMPLE);

  const initRet = mod._ff_prot_init();
  if (initRet !== 0) 
    throw new Error(`ff_prot_init 실패 (ret=${initRet})`);

  const paramRet = mod._ff_prot_set_param();
  if (paramRet !== 0) 
    throw new Error(`ff_prot_set_param 실패 (ret=${paramRet})`);

  const layout = new ClientWasmMemoryLayout(mod, bufPtr, tempPtr, excPtr, config, vSensingPtr, iSensingPtr);
  const analyze = (pcm: Uint8Array, params: EngineParams, sensing?: RealSensingPair): FrameResult => {
    return createAnalysisFrame(pcm, params, layout, config, opts, sensing);
  };

  const close = (): void => {
    const { count, firstCode } = layout.failureStats;
    if (count > 0) {
      console.warn(`ff_prot_start_exec 누적 실패 ${count}회 (최초 ret=${firstCode})`);
    }
    try {
      mod._ff_prot_stop_exec();
    } finally {
      mod._free(bufPtr);
      mod._free(tempPtr);
      mod._free(excPtr);
      mod._free(vSensingPtr);
      mod._free(iSensingPtr);
    }
  };

  return { analyze, close };
}
