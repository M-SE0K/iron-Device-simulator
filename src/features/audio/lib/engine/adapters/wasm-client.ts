/**
 * wasm-client.ts — ff_prot WASM 엔진 (브라우저 / Capacitor WebView 전용)
 *
 * public/wasm/ff_prot.{js,wasm}(native/build-wasm.sh 가 생성하는 브라우저 타깃 산출물)를
 * 브라우저에서 직접 로드해 실행한다. 서버(WebSocket)에 의존하지 않으므로 백엔드가
 * 번들에 포함되지 않는 모바일 앱(Capacitor iOS/Android) 패키징에 쓰인다.
 *
 * engine/adapters/wasm.ts(서버, Node 타깃)와 동일한 후처리 규약
 * (SPEAKER_PROFILES / powerTempMult)을 공유해 결과가 서버 WASM 모드와 일치한다.
 * openClientWasmSession() 호출마다 새 WASM 인스턴스를 만들므로(전역 상태 격리)
 * native.ts의 nativeLock 같은 동시 세션 제한이 필요 없다.
 */

import type { EngineParams } from "../../../types";
import {
  SAMPLES_PER_CH, CHANNELS, BYTES_PER_SAMPLE, FRAME_BYTES,
  type FrameResult, type AnalysisSession, type MemoryLayout,
} from "../core";
import { createAnalysisFrame } from "../utils";

const AMB_TEMP = 25; // 주변 온도(°C) — ff_prot_start_exec 인자

/** 브라우저 WASM 엔진의 메모리 레이아웃 구현 */
class ClientWasmMemoryLayout implements MemoryLayout {
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
    // free는 close에서 수행됨
  }
}

/** 하위 호환성을 위한 alias (이전 코드가 ClientFrameResult/ClientWasmSession 타입을 사용한 경우) */
export type ClientFrameResult = FrameResult;
export type ClientWasmSession = AnalysisSession;

// Emscripten MODULARIZE(ENVIRONMENT=web) 산출물: <script> 로드 시 전역
// window.FfProtModule 에 팩토리 함수가 얹힌다. 팩토리를 호출할 때마다
// 선형 메모리가 분리된 독립 인스턴스가 생성된다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FfProtInstance = any;
type FfProtFactory = () => Promise<FfProtInstance>;

let factoryPromise: Promise<FfProtFactory> | null = null;

function loadFactory(): Promise<FfProtFactory> {
  if (factoryPromise) return factoryPromise;

  factoryPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("wasm-client-engine은 브라우저 전용입니다."));
      return;
    }
    const w = window as unknown as { FfProtModule?: FfProtFactory };
    if (w.FfProtModule) {
      resolve(w.FfProtModule);
      return;
    }

    const script = document.createElement("script");
    script.src = "/wasm/ff_prot.js";
    script.onload = () => {
      const factory = (window as unknown as { FfProtModule?: FfProtFactory }).FfProtModule;
      if (!factory) {
        reject(new Error("FfProtModule을 찾을 수 없습니다 (wasm 스크립트 로드 실패)."));
        return;
      }
      resolve(factory);
    };
    script.onerror = () => reject(new Error("/wasm/ff_prot.js 로드 실패"));
    document.head.appendChild(script);
  });

  return factoryPromise;
}


/** 클라이언트 WASM 세션을 열고 ff_prot_init / set_param까지 수행한 뒤 반환한다. */
export async function openClientWasmSession(): Promise<AnalysisSession> {
  const factory = await loadFactory();
  const mod: FfProtInstance = await factory();

  const bufPtr  = mod._malloc(FRAME_BYTES);
  const tempPtr = mod._malloc(CHANNELS * 4); // int32_t[2]
  const excPtr  = mod._malloc(CHANNELS * 4); // int32_t[2]

  const initRet = mod._ff_prot_init();
  if (initRet !== 0) throw new Error(`ff_prot_init 실패 (ret=${initRet})`);
  const paramRet = mod._ff_prot_set_param();
  if (paramRet !== 0) throw new Error(`ff_prot_set_param 실패 (ret=${paramRet})`);

  // ── 단일 프레임 분석 ──────────────────────────────────────────────────────
  const layout = new ClientWasmMemoryLayout(mod, bufPtr, tempPtr, excPtr);
  const analyze = (pcm: Uint8Array, params: EngineParams): FrameResult => {
    return createAnalysisFrame(pcm, params, layout, false);
  };

  // ── 세션 종료: ff_prot_stop_exec + 힙 해제 ────────────────────────────────
  const close = (): void => {
    try {
      mod._ff_prot_stop_exec();
    } finally {
      mod._free(bufPtr);
      mod._free(tempPtr);
      mod._free(excPtr);
    }
  };

  return { analyze, close };
}
