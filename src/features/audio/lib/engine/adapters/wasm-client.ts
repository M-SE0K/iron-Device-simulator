/**
 * wasm-client.ts — ff_prot WASM 엔진 (브라우저 전용, 이 앱의 유일한 분석 엔진)
 * public/wasm/ff_prot.{js,wasm}(electron/native/wasm-engine/build-wasm.sh 가 생성하는 브라우저 타깃 산출물)를 브라우저에서 직접 로드해 실행한다. 서버에 의존하지 않으므로 정적 배포와 Electron 데스크톱 패키징 모두에 쓰인다.
 *
 * 프레임 분석 파이프라인은 engine/utils.ts의 createAnalysisFrame을 공유한다 — 온도/변위는
 * ff_prot_start_exec이 spk_temp/spk_exc에 써 준 값 그대로 나간다(TS측 보정 없음).
 * openClientWasmSession() 호출마다 새 WASM 인스턴스를 만들므로(전역 상태 격리)
 * 동시 세션 제한이 필요 없다.
 */

import type { EngineParams } from "../../../types";
import {
  CHANNELS, BYTES_PER_SAMPLE, frameBytes, DEFAULT_ENGINE_CONFIG,
  type FrameResult, type AnalysisSession, type MemoryLayout, type EngineRuntimeConfig, type RealSensingPair,
} from "../core";
import { createAnalysisFrame, type AnalysisFrameOptions } from "../utils";

/** 브라우저 WASM 엔진의 메모리 레이아웃 구현 */
class ClientWasmMemoryLayout implements MemoryLayout {
  constructor(
    private mod: FfProtInstance,
    private bufPtr: number,
    private tempPtr: number,
    private excPtr: number,
    private config: EngineRuntimeConfig,
    // v_sensing/i_sensing용 고정 스크래치 버퍼 — 세션 열 때 한 번 할당(samplesPerCh 고정),
    // sensing이 없는 프레임에서는 그냥 안 쓰고 0(NULL)을 넘긴다.
    private vSensingPtr: number,
    private iSensingPtr: number,
  ) {}

  // start_exec 실패 집계 — 세션(레이아웃 인스턴스)당 독립이다.
  private execFailures = 0;
  private firstFailureCode: number | null = null;

  // DEBUG(2026-07-21): V/I sensing 배선 확인용 프레임 카운터 — 확인 끝나면 필드째 제거할 것.
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
    // ff_prot_start_exec은 실제 벤더 시그니처(9-인자, sample_rate_hz 없음)를 따른다 —
    // v_sensing/i_sensing(2026-07-21 신규 확인, ff_prot.h 상단 주석 참고)은 local-socket.ts가
    // 골라 넘긴다: 4ch 이상 캡처면 전용 센싱 채널, 아니면 buf의 ch0(V)/ch1(I)
    // (useNativeCapture.ts → reframeNativeChunk.ts → local-socket.ts 경로, 채널 컨벤션
    // 확정 아님 — 벤더 확인 전 잠정치). sensing이 생략된 호출만 NULL(0)이 나가고, 그때는
    // ff_prot.c가 PCM RMS 근사로 자동 대체한다.
    //
    // 반환값은 계산 결과가 아니라 상태 코드다(0=성공, 음수=에러). 결과는 spk_temp/spk_exc
    // 포인터로 나가므로, 실패하면 그 메모리에 **아무것도 쓰이지 않는다** → 뒤이은
    // readResults()가 직전 프레임 값을 그대로 다시 읽는다(값이 멈춘 것처럼 보인다).
    let vArg = 0;
    let iArg = 0;
    if (sensing) {
      this.mod.HEAP16.set(sensing.v, this.vSensingPtr >> 1);
      this.mod.HEAP16.set(sensing.i, this.iSensingPtr >> 1);
      vArg = this.vSensingPtr;
      iArg = this.iSensingPtr;
    }

    // DEBUG(2026-07-21): V/I sensing이 WASM 힙에 실제로 쓰였는지 + 넘어갈 포인터가
    // 0이 아닌지 확인용 임시 로그. heapEcho는 방금 쓴 자리를 바로 다시 읽은 값이라,
    // JS→WASM 힙 쓰기가 실제로 반영됐는지 (_ff_prot_start_exec 호출 전에) 검증한다.
    // 확인 끝나면 이 블록째 제거할 것.
    this.debugFrame++;
    if (this.debugFrame % 100 === 0) {
      console.debug(
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
      // 프레임마다 throw하면(48kHz/512 기준 초당 ~94회) 일시적 오류에도 세션이 즉사한다.
      // 소켓 error 메시지도 쓸 수 없다 — useCaptureSession이 그걸 받으면 cleanup()으로
      // 세션 전체를 내린다. 그래서 첫 실패만 알리고 이후는 집계만 한다(총계는 close에서).
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

  /** 세션 동안 누적된 start_exec 실패 통계 — close()에서 총계를 남기는 데 쓴다. */
  get failureStats(): { count: number; firstCode: number | null } {
    return { count: this.execFailures, firstCode: this.firstFailureCode };
  }

  readProcessedPcm(bufPtr: number, samplesPerCh: number): Int16Array {
    // slice()로 복사한다 — subarray()가 돌려주는 뷰는 다음 프레임 writePlanar가 덮어쓰고,
    // 힙이 성장하면 backing ArrayBuffer가 detach되어 읽는 순간 예외가 난다.
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
    // free는 close에서 수행됨
  }
}

// Emscripten MODULARIZE(ENVIRONMENT=web) 산출물: <script> 로드 시 전역
// window.FfProtModule에 팩토리 함수가 얹힌다. 팩토리를 호출할 때마다 선형 메모리가 분리된 독립 인스턴스가 생성된다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FfProtInstance = any;
// moduleArg: Emscripten 팩토리에 넘기는 Module 오버라이드(locateFile 등). 브라우저 메인 스레드는
// 생략해도 <script> src에서 경로가 잡히지만, 워커는 currentScript가 없어 locateFile이 필수다.
type FfProtFactory = (moduleArg?: Record<string, unknown>) => Promise<FfProtInstance>;

let factoryPromise: Promise<FfProtFactory> | null = null;

function loadFactory(): Promise<FfProtFactory> {
  if (factoryPromise) return factoryPromise;

  factoryPromise = new Promise((resolve, reject) => {
    // 이미 로드됨 — 메인은 window, 워커는 self 전역에 팩토리가 얹혀 있다.
    const g = globalThis as unknown as { FfProtModule?: FfProtFactory };
    if (g.FfProtModule) {
      resolve(g.FfProtModule);
      return;
    }

    // Web Worker(classic): document가 없어 <script> 태그를 못 쓴다 — importScripts로 동기 로드.
    // ff_prot.js는 최상위 var로 전역(self.FfProtModule)에 팩토리를 얹으므로 로드 후 바로 집힌다.
    const importScriptsFn = (globalThis as unknown as {
      importScripts?: (...urls: string[]) => void;
    }).importScripts;
    if (typeof importScriptsFn === "function") {
      try {
        importScriptsFn("/wasm/ff_prot.js");
      } catch (err) {
        reject(new Error(`/wasm/ff_prot.js importScripts 실패: ${err}`));
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

    // 브라우저 메인 스레드: <script> 태그로 로드.
    if (typeof document === "undefined") {
      reject(new Error("wasm-client-engine은 브라우저 메인 스레드 또는 Web Worker 전용입니다."));
      return;
    }
    const script = document.createElement("script");
    script.src = "/wasm/ff_prot.js";
    script.onload = () => {
      const factory = (globalThis as unknown as { FfProtModule?: FfProtFactory }).FfProtModule;
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
export async function openClientWasmSession(
  config: EngineRuntimeConfig = DEFAULT_ENGINE_CONFIG,
  opts: AnalysisFrameOptions = {},
): Promise<AnalysisSession> {
  const factory = await loadFactory();
  // locateFile을 절대경로로 고정한다 — 워커엔 document.currentScript가 없어 scriptDirectory가
  // 비고, 그러면 ff_prot.wasm을 워커 청크 기준 상대경로로 fetch해 404가 난다. 메인 스레드에서도
  // 결과는 동일(/wasm/ff_prot.wasm)이라 양쪽에서 안전하다. (Phase 0 스파이크에서 확인)
  const mod: FfProtInstance = await factory({ locateFile: (path: string) => `/wasm/${path}` });

  const bufPtr  = mod._malloc(frameBytes(config));
  const tempPtr = mod._malloc(CHANNELS * 4); // int32_t[2]
  const excPtr  = mod._malloc(CHANNELS * 4); // int32_t[2]
  // v_sensing/i_sensing 스크래치 버퍼 — 채널 아닌 단일 스트림(samplesPerCh)이라 CHANNELS를
  // 곱하지 않는다. sensing 없는 프레임에서도 그냥 안 쓰일 뿐 세션 내내 재사용된다.
  const vSensingPtr = mod._malloc(config.samplesPerCh * BYTES_PER_SAMPLE);
  const iSensingPtr = mod._malloc(config.samplesPerCh * BYTES_PER_SAMPLE);

  const initRet = mod._ff_prot_init();
  if (initRet !== 0) 
    throw new Error(`ff_prot_init 실패 (ret=${initRet})`);

  const paramRet = mod._ff_prot_set_param();
  if (paramRet !== 0) 
    throw new Error(`ff_prot_set_param 실패 (ret=${paramRet})`);

  // ── 단일 프레임 분석 ──────────────────────────────────────────────────────
  const layout = new ClientWasmMemoryLayout(mod, bufPtr, tempPtr, excPtr, config, vSensingPtr, iSensingPtr);
  const analyze = (pcm: Uint8Array, params: EngineParams, sensing?: RealSensingPair): FrameResult => {
    return createAnalysisFrame(pcm, params, layout, config, opts, sensing);
  };

  // ── 세션 종료: ff_prot_stop_exec + 힙 해제 ────────────────────────────────
  const close = (): void => {
    // 실패는 프레임 단위로 조용히 지나가므로(execAnalysis 참고), 세션이 끝날 때 한 번은
    // 총계를 남겨야 "온도가 중간부터 안 움직였다" 같은 제보를 추적할 수 있다.
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
