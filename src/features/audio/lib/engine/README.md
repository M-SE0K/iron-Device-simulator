# engine

## 1. 도메인 설명

플레이어 컴포넌트가 서버 없이 브라우저 안에서 PCM 프레임을 스피커 온도(°C)·익스커션(콘 변위)으로 변환할 수 있게 하는 분석 엔진 계층이다. 개발자는 WebSocket 모양의 좁은 인터페이스(`SocketLike`) 하나만 다루면 되고 WASM(WebAssembly) 로드·메모리 관리·후처리 보정은 이 도메인이 전부 흡수한다.

내부는 관심사별 4계층으로 나뉜다: 공통 상수·인터페이스(`core.ts`, leaf 모듈), PCM 변환·분석 파이프라인(`utils.ts`), WASM 런타임 어댑터(`adapters/wasm-client.ts`), 그리고 과거 WebSocket 서버 프로토콜을 in-process로 흉내 내는 프로토콜 계층(`protocol/`)이다. 실제 계산은 `electron/native/wasm-engine/ff_prot.c`를 브라우저 타깃 WASM으로 빌드한 `public/wasm/ff_prot.{js,wasm}`이 담당하는데, **이 C 소스는 정품 벤더 라이브러리(`libirontune.so`)가 아니라 물리 근사 참조 스텁**이다 — RMS 기반 1차 열 RC 모델과 120 Hz 저역통과 피크로 온도·변위를 추정하며 정품 소스 수령 시 폐기 예정이다.

## 2. 프로젝트 전반에서의 역할

이 프로젝트는 서버·WebSocket·DB가 전혀 없는 브라우저 단독(single-page) 대시보드다. 그 전제를 성립시키는 곳이 이 도메인이다: 예전에 Next.js WS 서버가 하던 "init → binary PCM 프레임 → frame 메시지" 분석 프로토콜을 `LocalWasmSocket`이 페이지 안에서 그대로 재현하므로, `WaveformPlayer.tsx`(파일 재생)와 `MicrophonePlayer.tsx`(마이크/네이티브 캡처)는 서버 시절 코드 형태를 거의 유지한 채 동작한다.

소비자는 전부 `components/player/` 아래에 있다. 파일·마이크 공용 캡처 세션 `capture/useCaptureSession.ts`가 `createAnalysisSocket()`으로 소켓을 열고, `capture/useWebAudioWorkletCapture.ts`는 `encodeToInt16()`로 전송용 프레임을 만든다. Calibration UI의 `sampleRate`/`bufferSize`/`ambientTemp`/`speakerModel`/`ampOutputPower`는 init 메시지에 실려 이 도메인으로 들어와 WASM 세션 설정과 후처리 보정에 반영된다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `core.ts` | leaf 모듈(engine 내부를 import하지 않음, 순환 의존 방지). 프레임 포맷 상수(`SAMPLE_RATE`=48000, `CHANNELS`=2, `BYTES_PER_SAMPLE`=2, `SAMPLES_PER_CH`=480), `EngineRuntimeConfig`/`frameBytes()`, `DEFAULT_AMBIENT_TEMP`=25, 공통 인터페이스 `FrameResult`/`MemoryLayout`/`AnalysisSession`/`RealSensingPair` 정의 |
| `utils.ts` | PCM 변환과 분석 파이프라인. `encodeToInt16()`(플래너 Float32 쌍 → 인터리브 Int16, 플레이어 공용), `deinterleave()`(인터리브 → 플래너 Int16, `local-socket.ts`가 sensing 폴백에 재사용), 내부 함수 `interleaveFromPlanar()`(그 역변환), 이들을 묶은 `createAnalysisFrame()`(deinterleave → WASM 실행 → `FrameResult`). **후처리 보정 없음** — 온도/변위는 엔진이 `spk_temp`/`spk_exc`에 써 준 값 그대로다 |
| `adapters/wasm-client.ts` | 유일한 분석 엔진 어댑터. `/wasm/ff_prot.js`를 `<script>` 태그로 1회 로드하고 `openClientWasmSession()` 호출마다 새 WASM 인스턴스(분리된 선형 메모리)를 생성해 `ff_prot_init`/`ff_prot_set_param`까지 마친 `AnalysisSession`을 반환. `ClientWasmMemoryLayout`이 `MemoryLayout`을 구현한다 — 입력 PCM은 HEAP16에 쓰고, 온도/변위 결과(int32)는 HEAP32에서 읽는다 |
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

- **들어옴** — `features/audio/types.ts`에서 `EngineParams`/`WsServerMessage` 타입을 가져온다. 런타임 입력은 플레이어가 `SocketLike.send()`로 넣는 JSON init 메시지(Calibration 값)와 binary PCM 프레임(인터리브 Int16, ch0=V/ch1=I) 두 가지다.
- **나감** — `emit()`이 `onmessage`로 `WsServerMessage`(`ready`/`frame`/`error`)를 JSON 문자열로 돌려준다. `frame` 메시지는 `{type, frameIndex, time, temperature:[ch0,ch1], excursion:[ch0,ch1], processingMs}`. 이어서 `emitBinary()`가 같은 `frameIndex`를 단 **바이너리 메시지**(보호 감쇠 전/후 PCM 쌍)를 보낸다 — `protocol/analysis.ts`의 `encodeProcessedPcmMessage`/`decodeProcessedPcmMessage` 참고.
- **소비자(플레이어 → engine 방향)** — `capture/useCaptureSession.ts`가 `createAnalysisSocket`과 `BYTES_PER_SAMPLE`을; `capture/useNativeCapture.ts`·`capture/useWebAudioWorkletCapture.ts`가 `SocketLike` 타입을(웹 캡처는 `encodeToInt16`도); `capture/build-init-message.ts`가 `EngineRuntimeConfig`를 가져다 쓴다. `lib/wav-encoder.ts`는 `CHANNELS`/`BYTES_PER_SAMPLE`을 WAV 헤더 계산에 쓴다.
- **WASM 산출물** — `adapters/wasm-client.ts`가 `public/wasm/ff_prot.{js,wasm}`(`electron/native/wasm-engine/build-wasm.sh` 산출물, 원본은 참조 스텁 `electron/native/wasm-engine/ff_prot.c`)를 로드한다.

프레임 1개의 내부 처리 흐름:

```
send(ArrayBuffer) → LocalWasmSocket.handleFrame (크기 < frameBytes(config)면 폐기)
  → AnalysisSession.analyze → createAnalysisFrame
    → deinterleave (인터리브 → 플래너 Int16)
    → MemoryLayout.writePlanar (HEAP16에 쓰기)
    → _ff_prot_start_exec(bufPtr, samplesPerCh, 2, 2, ambientTemp, tempPtr, excPtr, vPtr, iPtr)  // 9-인자
                                                   // ⚠️ bufPtr은 In/Out — 보호 감쇠 결과가 여기에 되쓰인다
                                                   // vPtr/iPtr — local-socket이 고른 V/I sensing (항상 non-NULL)
    → readResults [T0, T1, E0, E1] → 그대로 FrameResult.temperature/excursion (보정 없음)
    → readProcessedPcm + interleaveFromPlanar (opts.includeProcessedPcm일 때만)
  → createFrameMessage (frameCount → time 환산) → emit → onmessage
  → encodeProcessedPcmMessage(frameIndex, input, processed) → emitBinary → onmessage(ArrayBuffer)
```

`buf`가 In/Out이라는 점이 중요하다 — `ff_prot_start_exec`은 온도/변위만 내놓는 게 아니라 **보호 감쇠가 적용된 PCM을 입력 버퍼에 되쓴다**(벤더 래퍼 `audio_ff_prot_processing`도 exec 직후 같은 버퍼를 다시 읽어 인터리브로 복원한다). 이 결과를 쓰려면 `readProcessedPcm`이 **복사본**을 떠야 한다 — WASM 힙 뷰는 다음 프레임에 덮어써지고 힙 성장 시 detach된다.

바이너리 메시지에 감쇠 **전** 입력까지 같이 싣는 이유는 비교 뷰(`components/channel/ProtectedComparePanel.tsx`) 때문이다. 캡처 청크(`rawCaptureRef`)는 프레임 경계도 채널 수도 분석 프레임과 달라 인덱스로 짝지을 수 없어서, 정렬을 프로토콜 수준에서 확정한다.

⚠️ 현재 감쇠 커브(`EXC_LIMIT_UM` 4000 µm / `TEMP_LIMIT_C` 85°C 기반)는 참조 스텁이 지어낸 임의값이다 — 파이프라인 검증용이며 실제 보호 성능이 아니다. UI에도 배지로 명시돼 있고, 정품 `.so` 수령 시 폐기한다.

Calibration `sampleRate`/`bufferSize`는 init 메시지 → `connConfig`(`EngineRuntimeConfig`)까지 그대로 전달된다. 세션 시작 후에는 바뀌지 않는다(다음 init에서 적용). 단 `ff_prot_start_exec`는 검증된 실제 벤더 시그니처(`sample_rate_hz` 없음, `electron/native/wasm-engine/VENDOR-API-SPEC.md` 2.2절)를 따르므로 `bufferSize`(samplesPerCh)만 그 호출 인자와 dt 계산에 반영되고, `sampleRate`는 캡처/와이어 세션 설정에만 쓰인다 — 엔진 내부 dt/LPF 계수는 스텁이 고정 `DEFAULT_SAMPLE_RATE_HZ`로 근사한다(`electron/native/wasm-engine/ff_prot.c`).

## 5. 주요 인터페이스 / 진입점

- `createAnalysisSocket(): SocketLike` (`protocol/local-socket.ts`) — 도메인의 대표 진입점. 항상 `LocalWasmSocket`을 반환하며 실제 WebSocket처럼 다음 마이크로태스크에 `onopen`이 온다. 프로토콜: ① `send(JSON.stringify({type:"init", ...}))` → `{type:"ready"}` 수신 후 ② binary 프레임 send → 프레임마다 `{type:"frame"}` 수신 ③ `{type:"stop"}` 또는 `close()`로 세션 해제. init 전에 보낸 binary 프레임은 조용히 버려진다.
- `SocketLike` (`protocol/local-socket.ts`) — `readyState`/`binaryType`/`bufferedAmount`/`send`/`close`/`onopen`/`onmessage`/`onerror`/`onclose`만 갖는 WebSocket 부분집합 인터페이스. 이벤트 핸들러 인자를 `any`로 두어 네이티브 WebSocket도 구조적으로 대입 가능하다.
- `openClientWasmSession(config?: EngineRuntimeConfig, opts?: AnalysisFrameOptions): Promise<AnalysisSession>` (`adapters/wasm-client.ts`) — WASM 세션을 직접 연다(보통은 소켓 경유로 충분). 브라우저 전용 — SSR(`typeof window === "undefined"`)에서는 reject. `ff_prot_init`/`ff_prot_set_param` 실패 시 throw.
- `AnalysisSession.analyze(pcm, params, sensing?): FrameResult` / `close(): void` (`core.ts`) — 프레임 1개 동기 분석. `FrameResult`는 `temperature: [number, number]`(`spk_temp` 그대로, °C), `excursion: [number, number]`(`spk_exc` 그대로, 스텁 출력 기준 µm), `processingMs`(소수 3자리 ms). 엔진이 이미 int32로 내보내므로 TS측 반올림·보정은 없다.
- `createAnalysisFrame(pcm, params, layout, config, opts?, sensing?): FrameResult` (`utils.ts`) — deinterleave → `MemoryLayout` 실행 → 결과 읽기의 단일 파이프라인. `pcm.subarray(0, frameBytes(config))`만 사용하므로 초과 바이트(= sensing 꼬리)는 여기서 무시된다 — 꼬리 분리는 `local-socket.ts`가 먼저 해서 `sensing`으로 넘긴다. `opts.includeProcessedPcm`은 보호 감쇠가 적용된 인터리브 PCM(`FrameResult.processedPcm`)을 결과에 포함한다 — 프레임마다 Int16Array를 새로 만들므로 소비자가 있을 때만 켠다(`local-socket.ts`가 켠다).
- `encodeToInt16(ch0: Float32Array, ch1: Float32Array): Int16Array` (`utils.ts`) — Float32 [-1, 1] 플래너 쌍을 int16 풀스케일(±32767) 인터리브 PCM으로 변환. 소켓에 보낼 binary 프레임을 만드는 표준 경로.
- `frameBytes(config: EngineRuntimeConfig): number` (`core.ts`) — `samplesPerCh × CHANNELS(2) × BYTES_PER_SAMPLE(2)`. 기본 설정(480 samples/ch)에서 1920 bytes/frame, 48 kHz 기준 10 ms/frame.
- `RealSensingPair` (`core.ts`) — `{ v: Int16Array; i: Int16Array }`, 각 `samplesPerCh` 길이의 모노 스트림이다. `protocol/frame-core.ts`의 `selectSensing`이 만들어내는데, MCHStreamer가 캡처 채널 수와 무관하게 실측 V/I 센스 라인을 항상 ch0(V)/ch1(I)로 실어 보내기 때문에 분석 `buf` 자체를 디인터리브해 그대로 `v`/`i`로 쓴다. `buf`가 항상 존재하는 만큼 이 값도 늘 채워지므로, `ff_prot.c`의 NULL 폴백(PCM RMS 근사)은 이 클라이언트 경로에서는 일어나지 않는다.
- `parseEngineParams` / `parseSampleRate` / `parseSamplesPerCh` (`protocol/analysis.ts`) — init 메시지 파싱. 기본값: `ambientTemp` 25°C, `sampleRate` 48000 Hz, `samplesPerCh` 480.
- 주의: `CHANNELS`(2)와 `BYTES_PER_SAMPLE`(2, int16)은 ABI 고정값이다 — 스텁 `ff_prot_start_exec`도 `bytes_per_sample != 2`면 `FF_PROT_ERR_BAD_FORMAT`을 반환한다. 단, 온도/변위 출력 버퍼(`spk_temp`/`spk_exc`)는 결과값이라 int32로 유지된다. 반면 `SAMPLE_RATE`/`SAMPLES_PER_CH`는 기본값일 뿐이며 세션마다 재정의된다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: 플레이어 캡처 세션 통합에 따른 소비자 목록 정정 — 삭제된 `stream/{useAnalysisStream,useBatchAnalysis,usePcmDecoder}` 대신 `capture/useCaptureSession`이 `createAnalysisSocket`을 여는 유일한 소비자로 변경, `wav-encoder` 소비 추가. 와이어 프레임 채널 표기 L R L R → ch0=V/ch1=I로 정정. 섹션 2·4 부분 갱신 (엔진 로직 자체의 int32/DEFAULT_AMBIENT_TEMP 변경은 최초 작성본에 이미 반영됨) (커밋 범위: e0add14..HEAD)
- 2026-07-14: 와이어/입력 PCM 샘플 폭을 int32에서 int16으로 통일한 것을 반영 — `BYTES_PER_SAMPLE` 4→2, `encodeToInt32`→`encodeToInt16`(풀스케일 ±32767), `deinterleave`가 Int16으로 읽고, `writePlanar`가 HEAP16(`bufPtr>>1`)에 쓴다. `ff_prot_start_exec`의 `bytes_per_sample` 인자와 스텁 검사도 2로, 기본 프레임 크기는 3840→1920 bytes/frame. 온도/변위 출력(`spk_temp`/`spk_exc`)은 결과값이라 int32로 유지한다. 섹션 2·3·4·5 부분 갱신 (커밋되지 않은 워크트리 변경 반영)
- 2026-07-16: `../iron-Device/`의 실제 `libirontune.so`를 nm/objdump로 역검증해 확인한 시그니처(`VENDOR-API-SPEC.md`)에 맞춰 `ff_prot_start_exec`을 8-인자(`sample_rate_hz` 포함)에서 7-인자(`sample_rate_hz` 없음)로 정렬 — `wasm-client.ts`/`ff_prot.c`/`ff_prot.h` 수정. `sampleRate`는 더 이상 엔진 호출 인자로 전달되지 않고, 엔진 스텁 내부는 고정 `DEFAULT_SAMPLE_RATE_HZ`로 dt/LPF를 근사한다(실제 라이브러리가 시간 정보를 어디서 얻는지는 여전히 미확인). 섹션 4·5 부분 갱신.
- 2026-07-21: `ff_prot_start_exec`의 `buf`가 In/Out이라는 벤더 래퍼 규약(`audio_ff_prot_processing`)을 확인하고, 참조 스텁에 보호 감쇠(3-pass: 입력 스캔 → 게인 램프 적용 → 감쇠 후 재추정)를 구현했다. 그 결과 PCM을 TS까지 돌려주는 경로(`MemoryLayout.readProcessedPcm` → `interleaveFromPlanar` → `FrameResult.processedPcm`)와, 감쇠 전/후 쌍을 실어 나르는 바이너리 메시지(`encodeProcessedPcmMessage`)를 추가. 소비자는 `useCaptureSession`(WAV 축적 + `getProtectedBlob`)과 `ProtectedComparePanel`(파형 비교·다운로드). 감쇠 커브는 스텁 임의값이라 UI에 "실제 보호 성능 아님" 배지를 붙였다. 섹션 3·4·5 부분 갱신.
- 2026-07-21: 차트가 `spk_temp`/`spk_exc`를 그대로 표시하도록 `applyPostCorrection`을 제거했다 — `SPEAKER_PROFILES`/`DEFAULT_PROFILE`/`powerTempMult`/`SpeakerProfile`(`core.ts`)과 쓰이지 않던 `AnalysisFrameOptions.includeRaw`/`FrameResult.raw`도 함께 삭제. ⚠️ Calibration의 `speakerModel`/`ampOutputPower`는 여전히 init 메시지로 엔진에 전달되지만 `ff_prot_set_param`이 NOP이라 **차트 값에 아무 영향이 없다**(예전엔 TS에서 승수로 곱했다). 같은 커밋에서 `v_sensing`/`i_sensing`을 실제로 배선했다 — `local-socket.ts`가 프레임 꼬리(4ch+ 전용 센싱 채널)를 우선하고 없으면 buf의 ch0/ch1을 넘긴다. 배선 전까지 `public/wasm/ff_prot.wasm`은 7-인자 빌드라 뒤 두 인자가 조용히 버려지고 있었으므로 9-인자로 재빌드했다(`build-wasm.sh`). 섹션 1·2·3·4·5 부분 갱신.
- 2026-07-23: 4ch 이상 캡처에서만 `reframeNativeChunk.ts`가 ch2/ch3를 별도 V/I 센싱 채널로 추출하던 로직(`SENSING_CHANNEL_INDEX`)을 제거했다 — MCHStreamer가 실측 V/I 센스 라인을 캡처 채널 수와 무관하게 항상 ch0(V)/ch1(I)로 보낸다고 실측 확인됐기 때문이다(ch2/ch3엔 애초에 V/I가 실리지 않았음). `protocol/frame-core.ts`의 `selectSensing`도 프레임 `byteLength`로 출처를 고르던 분기를 없애고 이제 항상 `buf`를 디인터리브해 `v_sensing`/`i_sensing`을 만든다. 섹션 5 부분 갱신.
