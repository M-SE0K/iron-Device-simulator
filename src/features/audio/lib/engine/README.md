# engine

## 1. 도메인 설명

플레이어 컴포넌트가 서버 없이 브라우저 안에서 PCM 프레임을 스피커 온도(°C)·익스커션(콘 변위)으로 변환할 수 있게 하는 분석 엔진 계층이다. 개발자는 WebSocket 모양의 좁은 인터페이스(`SocketLike`) 하나만 다루면 되고 WASM(WebAssembly) 로드·메모리 관리·후처리 보정은 이 도메인이 전부 흡수한다.

내부는 관심사별 4계층으로 나뉜다: 공통 상수·인터페이스(`core.ts`, leaf 모듈), PCM 변환·분석 파이프라인(`utils.ts`), WASM 런타임 어댑터(`adapters/wasm-client.ts`), 그리고 과거 WebSocket 서버 프로토콜을 in-process로 흉내 내는 프로토콜 계층(`protocol/`)이다. 실제 계산은 `native/ff_prot.c`를 브라우저 타깃 WASM으로 빌드한 `public/wasm/ff_prot.{js,wasm}`이 담당하는데, **이 C 소스는 정품 벤더 라이브러리(`libirontune.so`)가 아니라 물리 근사 참조 스텁**이다 — RMS 기반 1차 열 RC 모델과 120 Hz 저역통과 피크로 온도·변위를 추정하며 정품 소스 수령 시 폐기 예정이다.

## 2. 프로젝트 전반에서의 역할

이 프로젝트는 서버·WebSocket·DB가 전혀 없는 브라우저 단독(single-page) 대시보드다. 그 전제를 성립시키는 곳이 이 도메인이다: 예전에 Next.js WS 서버가 하던 "init → binary PCM 프레임 → frame 메시지" 분석 프로토콜을 `LocalWasmSocket`이 페이지 안에서 그대로 재현하므로, `WaveformPlayer.tsx`(파일 재생)와 `MicrophonePlayer.tsx`(마이크/네이티브 캡처)는 서버 시절 코드 형태를 거의 유지한 채 동작한다.

소비자는 전부 `components/player/` 아래에 있다. `stream/useAnalysisStream.ts`(실시간 스트림)·`stream/useBatchAnalysis.ts`(배치 분석)·`MicrophonePlayer.tsx`(마이크)가 각자 `createAnalysisSocket()`으로 자기 소켓을 열고 `stream/usePcmDecoder.ts`와 `capture/useWebAudioWorkletCapture.ts`는 `encodeToInt32()`/`frameBytes()`로 전송용 프레임을 만든다. Calibration UI의 `sampleRate`/`bufferSize`/`ambientTemp`/`speakerModel`/`ampOutputPower`는 init 메시지에 실려 이 도메인으로 들어와 WASM 세션 설정과 후처리 보정에 반영된다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `core.ts` | leaf 모듈(engine 내부를 import하지 않음, 순환 의존 방지). 프레임 포맷 상수(`SAMPLE_RATE`=48000, `CHANNELS`=2, `BYTES_PER_SAMPLE`=4, `SAMPLES_PER_CH`=480), `EngineRuntimeConfig`/`frameBytes()`, `DEFAULT_AMBIENT_TEMP`=25, `SPEAKER_PROFILES`(4종 물리 프로파일)+`powerTempMult()`, 공통 인터페이스 `FrameResult`/`MemoryLayout`/`AnalysisSession` 정의 |
| `utils.ts` | PCM 변환과 분석 파이프라인. `encodeToInt32()`(플래너 Float32 쌍 → 인터리브 Int32, 플레이어 공용), 내부 함수 `deinterleave()`(인터리브 → 플래너)와 `applyPostCorrection()`(raw 값 × 프로파일 × 전력 스케일), 이 둘을 묶은 `createAnalysisFrame()`(deinterleave → WASM 실행 → 보정 → `FrameResult`) |
| `adapters/wasm-client.ts` | 유일한 분석 엔진 어댑터. `/wasm/ff_prot.js`를 `<script>` 태그로 1회 로드하고 `openClientWasmSession()` 호출마다 새 WASM 인스턴스(분리된 선형 메모리)를 생성해 `ff_prot_init`/`ff_prot_set_param`까지 마친 `AnalysisSession`을 반환. `ClientWasmMemoryLayout`이 `MemoryLayout`을 HEAP32 접근으로 구현 |
| `protocol/analysis.ts` | 프로토콜 공통 헬퍼. init 메시지 파싱(`parseEngineParams`/`parseSampleRate`/`parseSamplesPerCh` — 미설정 시 기본값 대체) + 응답 메시지 생성(`createFrameMessage`/`createReadyMessage`/`createErrorMessage`), 프레임 인덱스 → 초 단위 시간 환산 |
| `protocol/local-socket.ts` | `LocalWasmSocket` + `createAnalysisSocket()`. WebSocket의 부분집합 `SocketLike`를 in-process로 구현: 문자열 send는 JSON 제어 메시지(init/stop), ArrayBuffer send는 PCM 프레임으로 처리해 `onmessage`로 결과를 흘려보낸다. `bufferedAmount`는 항상 0(백프레셔 없음) |

## 4. 의존성 및 흐름

내부 의존 방향은 단방향이다(역방향 import 없음):

```
core.ts (leaf)
  ← utils.ts
  ← protocol/analysis.ts
  ← adapters/wasm-client.ts (utils.ts도 사용)
  ← protocol/local-socket.ts (adapters/wasm-client.ts + protocol/analysis.ts 사용)
```

외부와의 데이터 교환:

- **들어옴** — `features/audio/types.ts`에서 `EngineParams`/`WsServerMessage` 타입을 가져온다. 런타임 입력은 플레이어가 `SocketLike.send()`로 넣는 JSON init 메시지(Calibration 값)와 binary PCM 프레임(인터리브 Int32, L R L R) 두 가지다.
- **나감** — `emit()`이 `onmessage`로 `WsServerMessage`(`ready`/`frame`/`error`)를 JSON 문자열로 돌려준다. `frame` 메시지는 `{type, time, temperature:[ch0,ch1], excursion:[ch0,ch1], processingMs}`.
- **소비자(플레이어 → engine 방향)** — `stream/useAnalysisStream.ts`, `stream/useBatchAnalysis.ts`, `MicrophonePlayer.tsx`가 `createAnalysisSocket`을; `capture/useNativeCapture.ts`, `capture/useWebAudioWorkletCapture.ts`가 `SocketLike` 타입을; `stream/usePcmDecoder.ts`, `stream/buildInitMessage.ts`가 `EngineRuntimeConfig`/`frameBytes`/`DEFAULT_ENGINE_CONFIG`/`encodeToInt32`를 가져다 쓴다.
- **WASM 산출물** — `adapters/wasm-client.ts`가 `public/wasm/ff_prot.{js,wasm}`(`native/build-wasm.sh` 산출물, 원본은 참조 스텁 `native/ff_prot.c`)를 로드한다.

프레임 1개의 내부 처리 흐름:

```
send(ArrayBuffer) → LocalWasmSocket.handleFrame (크기 < frameBytes(config)면 폐기)
  → AnalysisSession.analyze → createAnalysisFrame
    → deinterleave (인터리브 → 플래너 Int32)
    → MemoryLayout.writePlanar (HEAP32에 쓰기)
    → _ff_prot_start_exec(bufPtr, samplesPerCh, 4, 2, ambientTemp, sampleRate, tempPtr, excPtr)
    → readResults [T0, T1, E0, E1]
    → applyPostCorrection (× SPEAKER_PROFILES × powerTempMult)
  → createFrameMessage (frameCount → time 환산) → emit → onmessage
```

Calibration `sampleRate`/`bufferSize`는 init 메시지 → `connConfig`(`EngineRuntimeConfig`) → `ff_prot_start_exec`의 dt/LPF 계수 계산까지 그대로 전달된다. 세션 시작 후에는 바뀌지 않는다(다음 init에서 적용).

## 5. 주요 인터페이스 / 진입점

- `createAnalysisSocket(): SocketLike` (`protocol/local-socket.ts`) — 도메인의 대표 진입점. 항상 `LocalWasmSocket`을 반환하며 실제 WebSocket처럼 다음 마이크로태스크에 `onopen`이 온다. 프로토콜: ① `send(JSON.stringify({type:"init", ...}))` → `{type:"ready"}` 수신 후 ② binary 프레임 send → 프레임마다 `{type:"frame"}` 수신 ③ `{type:"stop"}` 또는 `close()`로 세션 해제. init 전에 보낸 binary 프레임은 조용히 버려진다.
- `SocketLike` (`protocol/local-socket.ts`) — `readyState`/`binaryType`/`bufferedAmount`/`send`/`close`/`onopen`/`onmessage`/`onerror`/`onclose`만 갖는 WebSocket 부분집합 인터페이스. 이벤트 핸들러 인자를 `any`로 두어 네이티브 WebSocket도 구조적으로 대입 가능하다.
- `openClientWasmSession(config?: EngineRuntimeConfig): Promise<AnalysisSession>` (`adapters/wasm-client.ts`) — WASM 세션을 직접 연다(보통은 소켓 경유로 충분). 브라우저 전용 — SSR(`typeof window === "undefined"`)에서는 reject. `ff_prot_init`/`ff_prot_set_param` 실패 시 throw.
- `AnalysisSession.analyze(pcm, params): FrameResult` / `close(): void` (`core.ts`) — 프레임 1개 동기 분석. `FrameResult`는 `temperature: [number, number]`(°C, 정수 반올림), `excursion: [number, number]`(스텁 출력 기준 µm, 정수 반올림), `processingMs`(소수 3자리 ms).
- `createAnalysisFrame(pcm, params, layout, config, includeRaw = false): FrameResult` (`utils.ts`) — deinterleave → `MemoryLayout` 실행 → 후처리 보정의 단일 파이프라인. `pcm.subarray(0, frameBytes(config))`만 사용하므로 초과 바이트는 무시된다.
- `encodeToInt32(ch0: Float32Array, ch1: Float32Array): Int32Array` (`utils.ts`) — Float32 [-1, 1] 플래너 쌍을 int32 풀스케일(±2147483647) 인터리브 PCM으로 변환. 소켓에 보낼 binary 프레임을 만드는 표준 경로.
- `frameBytes(config: EngineRuntimeConfig): number` (`core.ts`) — `samplesPerCh × CHANNELS(2) × BYTES_PER_SAMPLE(4)`. 기본 설정(480 samples/ch)에서 3840 bytes/frame, 48 kHz 기준 10 ms/frame.
- `powerTempMult(watt: number | null): number` (`core.ts`) — AMP 출력 전력 → 온도 승수. 기준 20 W, `(watt/20)^0.6` 근사. `null`/0 이하는 1.0.
- `SPEAKER_PROFILES` / `DEFAULT_PROFILE` (`core.ts`) — "Z3 SPK"(기준)·"PA3 SPK"·"B7 SPK"·"R8 SPK" 4종의 `tempMult`/`excMult`/`tempBase`/`excAmp`. 미선택("") 시 `DEFAULT_PROFILE`("Z3 SPK") 적용. 이 후처리 보정은 `ff_prot_set_param`이 NOP인 동안의 임시 규약으로, 정품 라이브러리가 직접 지원하면 폐기된다.
- `parseEngineParams` / `parseSampleRate` / `parseSamplesPerCh` (`protocol/analysis.ts`) — init 메시지 파싱. 기본값: `ambientTemp` 25°C, `sampleRate` 48000 Hz, `samplesPerCh` 480.
- 주의: `CHANNELS`(2)와 `BYTES_PER_SAMPLE`(4, int32)은 ABI 고정값이다 — 스텁 `ff_prot_start_exec`도 `bytes_per_sample != 4`면 `FF_PROT_ERR_BAD_FORMAT`을 반환한다. 반면 `SAMPLE_RATE`/`SAMPLES_PER_CH`는 기본값일 뿐이며 세션마다 재정의된다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
