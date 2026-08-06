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
    // WASM 엔진(ff_prot.c)은 여전히 int32[channels]를 채널별로 채우지만, 앱 레이어는
    // 더 이상 채널을 구분하지 않는 단일 값을 쓴다 — 대표값으로 ch0만 취한다.
    return [
      this.mod.HEAP32[tempPtr >> 2],
      this.mod.HEAP32[excPtr >> 2],
    ] as [number, number];
  }

  free() {
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FfProtInstance = any;
type FfProtFactory = (moduleArg?: Record<string, unknown>) => Promise<FfProtInstance>;

// WASM 산출물 경로. 기본은 public/wasm/ — 정적 export가 그대로 out/wasm/으로 복사한다.
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


export async function openClientWasmSession(
  config: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG,
  opts: AnalysisFrameOptions = {},
  wasmBinary?: Uint8Array<ArrayBuffer>,
): Promise<AnalysisSession> {
  const factory = await loadFactory();

  // WASM 알고리즘 암호화 배포(방법 5): Tauri 런타임에서는 평문 .wasm이 out/에 없다
  // (scripts/build/wasm-encryption/stage-encrypted-wasm.sh가 패키징 전에 지운다) — 호출자(메인 스레드의
  // LocalWasmSocket/WorkerAnalysisSocket)가 window.wasmAsset.loadEngineBinary()로 미리 복호화한
  // bytes를 여기 wasmBinary로 넘겨주면 그걸로 직접 인스턴스화해 글루의 자체 fetch를 우회한다.
  // 이 함수는 메인 스레드뿐 아니라 Web Worker(dsp-worker.ts) 안에서도 실행되는데, Worker
  // 전역 스코프엔 window가 없다 — 그래서 이 파일은 window를 직접 참조하지 않는다("바이너리를
  // 어떻게 구하느냐"는 항상 호출부 책임). 브라우저/build:desktop 경로(wasmBinary 미전달)는
  // 기존처럼 locateFile로 평문 .wasm을 fetch한다.
  const moduleArg: Record<string, unknown> = { locateFile: (path: string) => `${WASM_DIR}/${path}` };
  if (wasmBinary) {
    // Module.wasmBinary를 쓰면 안 된다 — emcc 6.x가 만드는 글루에는 그 필드를 읽는 분기 자체가
    // 없어서(난독화된 문자열 테이블에도 "wasmBinary"가 없다) 넘겨준 bytes가 조용히 무시되고
    // locateFile fetch로 떨어진다. 패키징된 Tauri 앱에는 평문 .wasm이 없으므로 그 fetch는
    // HTML(404 폴백)을 받아오고, 결국 "expected magic word 00 61 73 6d, found 3c 21 44 4f"
    // (3c 21 44 4f == "<!DO")로 터졌다. 글루가 실제로 존중하는 훅은 instantiateWasm뿐이다.
    //
    // compile을 먼저 해두는 이유: instantiateWasm 콜백 안에서 실패하면 글루가 감싼 Promise가
    // 영영 resolve되지 않아 앱이 조용히 멈춘다. 바이너리가 깨졌을 때 여기서 즉시 throw시켜
    // 호출부(local-socket.ts / dsp-worker.ts)의 try/catch에 잡히게 한다.
    const compiled = await WebAssembly.compile(wasmBinary);
    moduleArg.instantiateWasm = (
      imports: WebAssembly.Imports,
      success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => {
      void WebAssembly.instantiate(compiled, imports).then((instance) => success(instance, compiled));
      return {}; // 비동기 완료를 알리는 emscripten 규약(반환값 대신 success 콜백으로 넘긴다)
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
