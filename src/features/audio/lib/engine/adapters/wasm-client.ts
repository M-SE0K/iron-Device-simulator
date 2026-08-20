import type { EngineParams } from "../../../types";
import { round3 } from "@/shared/lib/utils";
import {
  CHANNELS, BYTES_PER_SAMPLE, frameBytes, DEFAULT_ENGINE_CONFIG, isTempOverflow,
  type FrameResult, type AnalysisSession, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import { deinterleave } from "../utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FfProtInstance = any;
type FfProtFactory = (moduleArg?: Record<string, unknown>) => Promise<FfProtInstance>;

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
        reject(new Error(`Failed to importScripts ${WASM_DIR}/ff_prot.js: ${err}`));
        return;
      }
      const factory = (globalThis as unknown as { FfProtModule?: FfProtFactory }).FfProtModule;
      if (!factory) {
        reject(new Error("Could not find FfProtModule (no global present after worker importScripts)."));
        return;
      }
      resolve(factory);
      return;
    }

    if (typeof document === "undefined") {
      reject(new Error("wasm-client-engine is only supported on the browser main thread or a Web Worker."));
      return;
    }
    const script = document.createElement("script");
    script.src = `${WASM_DIR}/ff_prot.js`;
    script.onload = () => {
      const factory = (globalThis as unknown as { FfProtModule?: FfProtFactory }).FfProtModule;
      if (!factory) {
        reject(new Error("Could not find FfProtModule (wasm script failed to load)."));
        return;
      }
      resolve(factory);
    };
    script.onerror = () => reject(new Error(`Failed to load ${WASM_DIR}/ff_prot.js`));
    document.head.appendChild(script);
  });

  return factoryPromise;
}

function interleaveFromPlanar(planar: Int16Array, samplesPerCh: number): Int16Array {
  const out = new Int16Array(samplesPerCh * CHANNELS);
  for (let ch = 0; ch < CHANNELS; ch++) {
    const base = ch * samplesPerCh;
    for (let i = 0; i < samplesPerCh; i++) {
      out[i * CHANNELS + ch] = planar[base + i];
    }
  }
  return out;
}

export async function openClientWasmSession(
  config: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG,
  wasmBinary?: Uint8Array<ArrayBuffer>,
): Promise<AnalysisSession> {
  const factory = await loadFactory();

  const moduleArg: Record<string, unknown> = { locateFile: (path: string) => `${WASM_DIR}/${path}` };
  if (wasmBinary) {
    const compiled = await WebAssembly.compile(wasmBinary);
    moduleArg.instantiateWasm = (
      imports: WebAssembly.Imports,
      success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => {
      void WebAssembly.instantiate(compiled, imports).then((instance) => success(instance, compiled));
      return {};
    };
  }
  const mod: FfProtInstance = await factory(moduleArg);

  const bufPtr  = mod._malloc(frameBytes(config));
  const tempPtr = mod._malloc(CHANNELS * 4);
  const excPtr  = mod._malloc(CHANNELS * 4);
  const vSensingPtr = mod._malloc(config.samplesPerCh * BYTES_PER_SAMPLE);
  const iSensingPtr = mod._malloc(config.samplesPerCh * BYTES_PER_SAMPLE);

  const initRet = mod._ff_prot_init();
  if (initRet !== 0)
    throw new Error(`ff_prot_init failed (ret=${initRet})`);

  const paramRet = mod._ff_prot_set_param();
  if (paramRet !== 0)
    throw new Error(`ff_prot_set_param failed (ret=${paramRet})`);

  let execFailures = 0;
  let firstFailureCode: number | null = null;

  const analyze = (pcm: Uint8Array, params: EngineParams, sensing?: RealSensingPair): FrameResult => {
    const t0 = performance.now();

    const planar = deinterleave(pcm.subarray(0, frameBytes(config)), config.samplesPerCh);
    mod.HEAP16.set(planar, bufPtr >> 1);

    let vArg = 0;
    let iArg = 0;
    if (sensing) {
      mod.HEAP16.set(sensing.v, vSensingPtr >> 1);
      mod.HEAP16.set(sensing.i, iSensingPtr >> 1);
      vArg = vSensingPtr;
      iArg = iSensingPtr;
    }

    const ret = mod._ff_prot_start_exec(
      bufPtr,
      config.samplesPerCh,
      BYTES_PER_SAMPLE,
      CHANNELS,
      params.ambientTemp,
      tempPtr,
      excPtr,
      vArg,
      iArg,
    );

    if (ret !== 0) {
      if (execFailures === 0) {
        firstFailureCode = ret;
        console.warn(
          `ff_prot_start_exec 실패 (ret=${ret}) — 이 프레임의 온도/변위는 직전 값이 유지됩니다. ` +
          "이후 동일 오류는 집계만 하고 세션은 유지합니다.",
        );
      }
      execFailures++;
    }

    const rawTemperature = mod.HEAP32[tempPtr >> 2];
    const rawExcursion = mod.HEAP32[excPtr >> 2];

    /* 온도가 500°C 이상이면 열모델이 발산한 것으로 보고 온도/변위를 함께 0 으로 깐다.
     * processedPcm(보호 재생 신호)은 건드리지 않는다 — 스피커로 나가는 소리는 그대로. */
    const overflowed = isTempOverflow(rawTemperature);
    const temperature = overflowed ? 0 : rawTemperature;
    const excursion = overflowed ? 0 : rawExcursion;

    const start = bufPtr >> 1;
    const processedPlanar = mod.HEAP16.slice(start, start + config.samplesPerCh * CHANNELS);
    const processedPcm = interleaveFromPlanar(processedPlanar, config.samplesPerCh);

    return {
      temperature,
      excursion,
      processingMs: round3(performance.now() - t0),
      processedPcm,
      tempOverflow: overflowed,
    };
  };

  const close = (): void => {
    if (execFailures > 0) {
      console.warn(`ff_prot_start_exec 누적 실패 ${execFailures}회 (최초 ret=${firstFailureCode})`);
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
