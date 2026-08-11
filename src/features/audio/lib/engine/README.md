# engine

## 1. 도메인 설명

서버 없이 브라우저(WASM) 안에서 스피커 온도·변위를 계산하는 분석 엔진입니다. 결과는 WebSocket과 똑같이 생긴 API로 감싸 두었습니다. 그래서 이 도메인을 쓰는 쪽(`player/`)은 실제로 네트워크를 전혀 타지 않는다는 사실을 몰라도 됩니다.

## 2. 프로젝트 전반에서의 역할

외부에서 이 도메인에 들어오는 문은 `createAnalysisSocket()` 하나뿐입니다. `player/`의 `useCaptureSession.ts`가 이걸 호출해 `SocketLike` 계약(WebSocket의 좁은 부분집합)만 보고 씁니다. 그 안쪽은 실행 경로가 둘로 나뉩니다 — 기본은 Web Worker(`WorkerAnalysisSocket`)에서 돌고 `USE_WORKER_ENGINE=0`이거나 워커 생성이 실패하면 메인 스레드(`LocalWasmSocket`)로 내려갑니다. 어느 쪽으로 가도 프레임 하나를 처리하는 실제 로직(`frame-core.ts`)은 공유합니다. `ff_prot.c`를 컴파일한 WASM 산출물 자체는 `native/wasm-engine/`이 만듭니다. 이 도메인은 그 산출물을 로드해서 호출하는 JS/TS 쪽입니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `core.ts` | ABI 상수(`SAMPLE_RATE`/`CHANNELS`/`BYTES_PER_SAMPLE`/`SAMPLES_PER_CH`), `FrameResult`/`MemoryLayout`/`AnalysisSession` 인터페이스, `frameBytes()` |
| `utils.ts` | `encodeToInt16()`/`deinterleave()` wire↔planar 변환, 분석 파이프라인을 하나로 묶은 `createAnalysisFrame()` |
| `adapters/wasm-client.ts` | `ff_prot.c` WASM 빌드 로드와 세션 열기(`openClientWasmSession`), `MemoryLayout` 구현체 `ClientWasmMemoryLayout` |
| `protocol/analysis.ts` | 메시지 파싱/빌딩 — `parseEngineParams`/`parseSampleRate`/`parseSamplesPerCh`, `createFrameMessage`, processedPcm 인코딩/디코딩 |
| `protocol/frame-core.ts` | `processAnalysisFrame()` — 메인/워커 양쪽이 공유하는 로직. 실측 V/I 센싱 프레임 선택, 분석 호출, 응답 메시지 조립까지 |
| `protocol/socket-types.ts` | `SocketLike`(WebSocket 부분집합) 인터페이스 |
| `protocol/local-socket.ts` | 메인 스레드 in-process 소켓 `LocalWasmSocket`과 진입점 `createAnalysisSocket()` |
| `protocol/worker-socket.ts` | 워커를 대신 말해주는 프록시 소켓 `WorkerAnalysisSocket` |
| `worker/dsp-worker.ts` | 실제 Web Worker 스레드 안에서 도는 엔진 루프 |

## 4. 의존성 및 흐름

- **가져오는 것**: `features/audio/types`의 `EngineParams`/`WsServerMessage`, `@/shared/lib/utils`의 `round3`.
- **Tauri 암호화 배포와의 접점**: `adapters/wasm-client.ts`는 `window.wasmAsset`(Tauri 셸에서 `shared/lib/tauri-bridge`가 제공)이 있으면 Rust가 복호화한 바이트를 `Module.wasmBinary`로 직접 주입합니다. 일반 브라우저/`build:desktop` 경로에는 이 전역이 없으니 기존처럼 `locateFile`로 평문 `.wasm`을 fetch합니다.
- **외부에서 들어오는 유일한 진입점**: `player/`의 `useCaptureSession.ts`가 `createAnalysisSocket()` 하나만 호출합니다. `SocketLike` 계약이 메인/워커 스레드 차이를 완전히 가립니다.

```
useCaptureSession.ts → createAnalysisSocket()
  → (기본, USE_WORKER_ENGINE≠"0") WorkerAnalysisSocket → dsp-worker.ts(별도 스레드)
        → openClientWasmSession() → processAnalysisFrame() → 결과를 postMessage로 반환
  → (USE_WORKER_ENGINE="0" 또는 워커 생성 실패) LocalWasmSocket(메인 스레드, in-process)
        → openClientWasmSession() → processAnalysisFrame()
```

## 5. 주요 인터페이스 / 진입점

- **`createAnalysisSocket(): SocketLike`** — 이 도메인의 유일한 외부 진입점. 기본은 `WorkerAnalysisSocket`을 돌려주고 `USE_WORKER_ENGINE="0"`이거나 워커 생성이 실패하면 `LocalWasmSocket`으로 폴백합니다.
- **`SocketLike`** — WebSocket의 좁은 부분집합(`readyState`/`send`/`close`/`onopen`/`onmessage`/`onerror`/`onclose`). `send()`에 문자열을 넘기면 `"init"`/`"stop"` 제어 메시지로, `ArrayBuffer`를 넘기면 PCM 프레임으로 해석합니다.
- **`openClientWasmSession(config?: EngineRuntimeConfig, opts?: AnalysisFrameOptions): Promise<AnalysisSession>`** — `ff_prot.c` WASM 세션을 엽니다. `AnalysisSession.analyze(pcm, params, sensing?): FrameResult` / `.close()`.
- **`createAnalysisFrame(pcm, params, layout, config, opts?, sensing?): FrameResult`** — deinterleave → WASM 메모리 쓰기 → `ff_prot_start_exec` 호출 → 결과 읽기까지 한 프레임 처리의 전체 파이프라인.
- **`processAnalysisFrame(session, data, engineParams, config, frameIndex): FrameOutput | null`** — wire 프레임을 받아 `session.analyze()` 호출과 응답 메시지 조립까지 감싼 공유 로직. 버퍼 프레임 뒤에 센싱 프레임을 이어붙인 2배 길이 메시지도 받습니다. 프레임 길이가 부족하면 `null`.
- **`deinterleave(src, samplesPerCh): Int16Array`** / **`encodeToInt16(ch0, ch1): Int16Array`** — wire(인터리브) ↔ planar 변환.
- **`frameBytes(config: EngineRuntimeConfig): number`** — 세션 하나의 wire 프레임 바이트 크기(`samplesPerCh × CHANNELS × BYTES_PER_SAMPLE`).
- **`FrameResult`** — `{ temperature, excursion, processingMs, processedPcm? }`.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. Web Worker 오프로딩 경로(`protocol/worker-socket.ts`, `worker/dsp-worker.ts`, `USE_WORKER_ENGINE`)가 기본 경로로 자리 잡은 상태와 Tauri 암호화 WASM 배포(`window.wasmAsset`) 연동까지 반영했습니다(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
