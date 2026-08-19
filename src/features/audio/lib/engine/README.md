# engine

## 1. 도메인 설명

서버 없이 브라우저(WASM) 안에서 스피커 온도·변위를 계산하는 분석 엔진입니다. 결과는 콜백 기반 `EngineClient` 계약으로 감싸 두었습니다. 그래서 이 도메인을 쓰는 쪽(`player/`)은 분석이 Web Worker에서 도는지 메인 스레드에서 도는지 몰라도 됩니다.

## 2. 프로젝트 전반에서의 역할

외부에서 이 도메인에 들어오는 문은 `createEngineClient()` 하나뿐입니다. `player/`의 `useCaptureSession.ts`가 이걸 호출해 `EngineClient` 계약(`init`/`sendFrame`/`stop` + 콜백 5종)만 보고 씁니다. 그 안쪽은 실행 경로가 둘로 나뉩니다 — 기본은 Web Worker(`WorkerEngineClient` → `dsp-worker.ts`)에서 돌고 워커 생성이 실패하면 메인 스레드(`LocalEngineClient`)로 내려갑니다. 과거의 `USE_WORKER_ENGINE` 환경변수 스위치는 제거됐습니다. 어느 쪽으로 가도 세션 상태 관리(`session-core.ts`의 `EngineSessionCore`)와 프레임 하나를 처리하는 실제 로직(`frame-core.ts`)은 공유합니다. `ff_prot.c`를 컴파일한 WASM 산출물 자체는 `native/wasm-engine/`이 만듭니다. 이 도메인은 그 산출물을 로드해서 호출하는 JS/TS 쪽입니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `core.ts` | ABI 상수(`SAMPLE_RATE`/`CHANNELS`/`BYTES_PER_SAMPLE`/`SAMPLES_PER_CH`/`INT16_*`), `clampCaptureChannels()`, `frameBytes()`, `FrameResult`/`RealSensingPair`/`AnalysisSession` 인터페이스 |
| `utils.ts` | `encodeToInt16()`/`deinterleave()` wire↔planar 변환 (분석 파이프라인은 `adapters/wasm-client.ts` 세션 내부로 이동) |
| `adapters/wasm-client.ts` | `ff_prot.c` WASM 빌드 로드(메인 스레드는 `<script>`, 워커는 `importScripts`)와 세션 열기(`openClientWasmSession`). `analyze`는 세션당 1회 할당한 힙 버퍼(buf/temp/exc/vSensing/iSensing)를 재사용 |
| `protocol/analysis.ts` | `EngineInitPayload` 파싱(`parseEngineParams`/`parseSampleRate`/`parseSamplesPerCh`)과 응답 메시지 조립(`createFrameMessage`/`createReadyMessage`/`createErrorMessage`) |
| `protocol/frame-core.ts` | `processAnalysisFrame()` — `[buf ‖ sensing]` 2배 길이 wire 프레임 해석, 실측 V/I 센싱 분리, 분석 호출, `frame` 메시지 + `ProtectedPcm` 조립 |
| `protocol/session-core.ts` | `EngineSessionCore` — init/processFrame/stop 세션 상태 머신. 메인(`LocalEngineClient`)과 워커(`dsp-worker.ts`)가 공유하며, init 완료 전 도착한 프레임을 버리고 개수를 셉니다(워밍업 드롭) |
| `protocol/engine-client.ts` | `EngineClient` 인터페이스와 진입점 `createEngineClient()`. 워커 구현(`WorkerEngineClient`, 프레임 배칭+transfer 전달)과 메인 스레드 폴백(`LocalEngineClient`), `worker_roundtrip` 계측 |
| `worker/dsp-worker.ts` | Web Worker 스레드 진입점 — `WorkerRequest`(init/frames/stop)를 받아 `EngineSessionCore`를 돌리고 결과를 배치로 postMessage(transfer 포함) |

## 4. 의존성 및 흐름

- **가져오는 것**: `features/audio/types`의 `EngineParams`/`EngineMessage`/`EngineFrameMessage`, `@/shared/lib/utils`의 `round3`, `@/shared/lib/iron-perf`의 `isIronPerfEnabled`/`recordPerfSample`(계측이 꺼져 있으면 기록하지 않음).
- **Tauri 암호화 배포와의 접점**: `WorkerEngineClient`가 init 시 **메인 스레드에서** `window.wasmAsset?.loadEngineBinary()`(Tauri 셸에서 `shared/lib/tauri-bridge`가 제공)를 호출해 Rust가 복호화한 바이트를 받은 뒤 그 버퍼를 transfer로 워커에 넘깁니다. `openClientWasmSession(config, wasmBinary)`은 받은 바이트를 `WebAssembly.compile` + `instantiateWasm` 훅으로 주입합니다. 전역이 없는 일반 브라우저에서는 기존처럼 `locateFile`로 평문 `.wasm`을 fetch합니다. 메인 스레드 폴백(`LocalEngineClient`)은 `wasmBinary` 없이 `EngineSessionCore.init()`을 호출하므로 항상 평문 fetch 경로를 탑니다.
- **외부에서 들어오는 유일한 진입점**: `player/`의 `useCaptureSession.ts`가 `createEngineClient()` 하나만 호출합니다. `EngineClient` 계약이 메인/워커 스레드 차이를 완전히 가립니다.

```
useCaptureSession.ts → createEngineClient()
  → (기본) WorkerEngineClient — sendFrame()을 마이크로태스크로 모아 {type:"frames"} 배치 + transfer
        → dsp-worker.ts(별도 스레드) → EngineSessionCore.processFrame() → processAnalysisFrame()
        → 결과 배치 {results}를 transfer로 반환
  → (워커 생성 실패 시) LocalEngineClient(메인 스레드) → 동일한 EngineSessionCore를 in-process 호출
결과 전달: onReady(warmupDroppedFrames) / onFrame(frame) / onProtectedPcm({frameIndex, input, processed})
          / onError(message) / onTransportError()
```

## 5. 주요 인터페이스 / 진입점

- **`createEngineClient(): EngineClient`** — 이 도메인의 유일한 외부 진입점. 기본은 `WorkerEngineClient`를 돌려주고 워커 생성이 실패하면 `LocalEngineClient`로 폴백합니다.
- **`EngineClient`** — `init(payload)`/`sendFrame(data)`/`stop()` + 콜백 5종(`onReady`/`onFrame`/`onProtectedPcm`/`onError`/`onTransportError`). `sendFrame`은 `[보호 대상 buf ‖ 실측 센싱]`을 이어붙인 `frameBytes(config) × 2` 바이트 `ArrayBuffer`를 받습니다. 미만이면 그 프레임을 무시합니다. init 완료 전 보낸 프레임은 버려지되 프레임 인덱스는 계속 증가하고 버린 개수가 `onReady(warmupDroppedFrames)`로 보고됩니다.
- **`EngineInitPayload`** — `{ sampleRate: number; bufferSize: number; ambientTemp: string }`. `ambientTemp`가 숫자로 파싱되지 않으면 `DEFAULT_AMBIENT_TEMP`(25°C)를 씁니다.
- **`openClientWasmSession(config?: EngineRuntimeConfig, wasmBinary?: Uint8Array): Promise<AnalysisSession>`** — `ff_prot.c` WASM 세션을 엽니다. `wasmBinary`를 주면 복호화 바이트로 인스턴스화합니다.
- **`AnalysisSession.analyze(pcm: Uint8Array, params, sensing?): FrameResult`** / **`.close()`** — `ff_prot_start_exec` 실패(ret≠0) 시 최초 1회만 경고하고 세션은 유지합니다. `close()`에서 누적 실패 횟수를 로그로 남깁니다.
- **`processAnalysisFrame(session, data, engineParams, config, frameIndex): FrameOutput | null`** — wire 프레임을 받아 `session.analyze()` 호출과 응답 조립까지 감싼 공유 로직. `data.byteLength < frameBytes × 2`면 `null`. 반환 `FrameOutput = { frame: EngineFrameMessage, pcm: ProtectedPcm }`.
- **`ProtectedPcm`** — `{ frameIndex, input: Int16Array, processed: Int16Array }`. 보호 전 원본과 ff_prot 통과본 쌍.
- **`deinterleave(src, samplesPerCh): Int16Array`** / **`encodeToInt16(ch0, ch1): Int16Array`** — wire(인터리브) ↔ planar 변환.
- **`frameBytes(config: EngineRuntimeConfig): number`** — 세션 하나의 wire 프레임 바이트 크기(`samplesPerCh × CHANNELS × BYTES_PER_SAMPLE`).
- **`FrameResult`** — `{ temperature, excursion, processingMs, processedPcm }`. `processedPcm`(보호 PCM)은 이제 항상 채워집니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. Web Worker 오프로딩 경로(`protocol/worker-socket.ts`, `worker/dsp-worker.ts`, `USE_WORKER_ENGINE`)가 기본 경로로 자리 잡은 상태와 Tauri 암호화 WASM 배포(`window.wasmAsset`) 연동까지 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: WebSocket 모방 소켓 계층(`local-socket.ts`/`worker-socket.ts`/`socket-types.ts`) 제거 → 콜백 계약 `EngineClient`(`engine-client.ts`)와 메인/워커 공유 세션 코어(`session-core.ts`)로 재편. `createAnalysisFrame()`/`MemoryLayout`은 `wasm-client.ts` 세션 내부로 흡수되어 힙 버퍼를 세션당 1회만 할당하고, init은 JSON 문자열 대신 `EngineInitPayload` 객체, wire 프레임은 `[buf ‖ sensing]` 2배 길이 필수, 워커 전달은 프레임 배칭+transfer로 변경. 암호화 WASM 로드가 메인 스레드(`loadEngineBinary`) → 워커 transfer 주입으로 이동했고 `USE_WORKER_ENGINE` 스위치는 제거, `worker_roundtrip`/`wasm_engine` iron-perf 계측을 연결했습니다 (커밋 범위: a465514..24d1daa)
