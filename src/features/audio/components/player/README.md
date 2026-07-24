# player

## 1. 도메인 설명

오디오 입력(업로드 파일 재생·마이크/네이티브 캡처)에서 실제 하드웨어가 되돌려 주는 ch0(V)/ch1(I) 센스 신호를 캡처해 WASM(WebAssembly) 분석 엔진에 흘려보내고, 엔진이 돌려주는 온도·익스커션 프레임을 대시보드로 전달하는 입력 계층이다. 개발자는 이 도메인만 보면 "소리가 어떻게 분석 프레임이 되는가"의 전 과정을 파악할 수 있다.

핵심은 파일 모드와 마이크 모드가 **하나의 캡처 파이프라인**(`capture/useCaptureSession.ts`)을 공유한다는 점이다. 파일 모드는 업로드 PCM을 직접 분석하지 않는다 — WaveSurfer로 파일을 재생해 출력 장치(앰프/스피커)로 내보내는 동시에, 그 하드웨어 응답을 ch0(V)/ch1(I)로 캡처해 분석한다. 마이크 모드는 재생 없이 같은 세션을 직접 연다. 두 컴포넌트 모두 `createAnalysisSocket()`이 돌려주는 WebSocket 모양의 인프로세스 소켓(`LocalWasmSocket`)에 대고 쓰기 때문에, 코드가 WebSocket API 형태여도 데이터는 페이지 밖으로 나가지 않는다.

와이어 프레임 포맷은 인터리브 Int16(V I V I, `BYTES_PER_SAMPLE` = 2바이트)이고, 기본 설정(48 kHz, 480 samples/ch)에서 엔진에 보내는 분석 프레임 1개는 480 × 2ch × 2바이트 = **1920 bytes/frame**, 10 ms 분량이다. 네이티브 캡처는 Calibration의 채널 수(최대 8ch)만큼 장치 채널을 열지만 엔진에는 ch0/ch1만 보내고 나머지는 세션 버퍼에 보존한다. `sampleRate`/`bufferSize`는 Calibration UI 값이 세션 시작 시점에 `EngineRuntimeConfig`로 고정되므로 고정 상수가 아니다.

## 2. 프로젝트 전반에서의 역할

`DashboardClient.tsx`(`components/dashboard/`)가 두 플레이어를 모두 마운트하고, 플레이어가 올려보내는 `AnalysisFrame`(`onFrameReceived`)을 출력 큐/FIFO를 거쳐 Temperature/Excursion 차트로 렌더링한다. 즉 이 도메인은 프로젝트 데이터 흐름의 최상류(입력 → 분석 요청)를 담당하고, 하류(수신 프레임의 코얼레싱·이벤트 검출·차트)는 `dashboard/` + `lib/render/`가 담당한다.

- 파일 모드: `WaveformPlayer`가 WaveSurfer로 파일을 재생(`calibration.outputDeviceId`로 `setSinkId()` 출력 라우팅)하면서 재생 시작과 동시에 캡처 세션을 열어 실제 하드웨어 응답(ch0=V/ch1=I)을 분석한다.
- 마이크 모드: `MicrophonePlayer`가 재생 없이 같은 캡처 세션을 열고 캡처 청크를 같은 `onFrameReceived` 콜백으로 흘려보낸다.
- V/I 센싱: 네이티브 캡처 경로는 채널 의미를 ch0 = V(전압 센스), ch1 = I(전류 센스)로 확정해 이 두 채널만 엔진에 보내고 Calibration에서 확장한 나머지 채널(ch2..chN-1)은 세션 버퍼에 보존했다가 "저장" 시 전 채널 WAV로 내보낸다.

외부에서 이 도메인을 import하는 파일은 `components/dashboard/DashboardClient.tsx`(두 플레이어 + `WaveformPlayerHandle`/`MicRecordingExport`) 한 곳이다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `WaveformPlayer.tsx` | 파일 재생 오케스트레이터. WaveSurfer 생성/파괴, 재생 컨트롤 UI, `calibration.outputDeviceId`에 따른 `setSinkId()` 출력 라우팅을 담당하고 분석 파이프라인은 `useCaptureSession` 한 인스턴스에 위임한다. 최초 재생 시 캡처 세션을 시작하고, 일시정지는 세션을 끊지 않고 저장 버퍼만 멈춘다(`pauseRecording`/`resumeRecording`). ref로 `WaveformPlayerHandle`(`sendMessage`/`pause`/`exportRecordedAudio`/`subscribeCaptureStream`) 노출. |
| `MicrophonePlayer.tsx` | 라이브 캡처 오케스트레이터 — `useCaptureSession`을 감싸는 얇은 UI 셸이다. 시작/중지 버튼, 장치명/샘플레이트/버퍼/레이턴시 readout(대기 중)과 송·수신 프레임 카운터(녹음 중), 오류 표시, 정지 후 나타나는 전 채널 "저장" 버튼(`saveRecording`)만 렌더한다. `MicRecordingExport`는 `CaptureRecordingExport`의 재export. |
| `capture/useCaptureSession.ts` | 파일·마이크 공용 캡처+분석+녹음 세션 훅. 분석 소켓(`createAnalysisSocket`)과 `onmessage`(ready/frame/error) 핸들링을 소유하고, 실제 캡처는 `window.audioCapture` 존재 시 `useNativeCapture`, 부재 시 `useWebAudioWorkletCapture`로 분기한다. 세션 동안의 전 채널 원본 PCM(`rawCaptureRef`)을 축적해 `saveRecording()`/`getRecordedBlob()`으로 WAV 인코딩한다. `pauseRecording`/`resumeRecording`은 소켓/캡처를 유지한 채 분석 프레임 전송과 저장 버퍼 축적만 함께 멈춘다(재생 일시정지 시 WASM 온도 누적·차트 시간축 보존용). |
| `stream/buildInitMessage.ts` | 분석 소켓 `init` 메시지(JSON: `ampOutputPower`/`speakerModel`/`ambientTemp`/`sampleRate`/`bufferSize`) 빌더. 파일·마이크 캡처 세션이 공유한다. |
| `capture/useNativeCapture.ts` | Electron CoreAudio 캡처 경로. `window.audioCapture.start()`로 상주 헬퍼를 띄우고 장치가 실제 적용한 `actual.sampleRate`/`actual.bufferSize`를 우선해 소켓 init에 반영한다("actual 우선" 원칙). `actual.bufferSize`(samplesPerCh)는 그대로 `ff_prot_start_exec`의 dt 계산 인자로 쓰이지만, `actual.sampleRate`는 와이어/세션 설정에만 쓰이고 엔진 호출 인자로는 전달되지 않는다(검증된 실제 벤더 시그니처엔 `sample_rate_hz`가 없음 — `electron/native/wasm-engine/VENDOR-API-SPEC.md` 2.2절). 청크는 reframer를 거쳐 2ch(V/I) 분석 프레임과 전 채널 원본 프레임으로 분기된다. |
| `capture/useWebAudioWorkletCapture.ts` | 웹/모바일 폴백 캡처 경로. getUserMedia(`echoCancellation`/`noiseSuppression`/`autoGainControl` 모두 off, `inputDeviceId` 지정 시 `deviceId: { exact }`) → `/mic-processor.js` AudioWorklet(`processorOptions.samplesPerCh` 청킹) → `encodeToInt16()` → 소켓 전송. BufferSize는 Chromium이 주인이라 latency 힌트만 전달한다. |
| `capture/reframeNativeChunk.ts` | `createNativeFrameReframer()` — N채널 인터리브 int16 청크를 `wireSamplesPerCh` 프레임 경계로 재구성하는 순수 함수(훅 아님). 미완성 device-frame 잔여 바이트(`pending`)와 미완성 출력 프레임(`outCount`)을 내부 이월해 경계를 유지하고 ch0/ch1을 `onFrame`으로, 전 채널 원본을 `onRawFrame`으로 방출한다. |

## 4. 의존성 및 흐름

이 도메인이 import하는 모듈(방향: player → 대상):

- `lib/engine/protocol/local-socket.ts` — `createAnalysisSocket()`/`SocketLike`. PCM 프레임을 보내고 `frame` 메시지를 받는 유일한 분석 창구.
- `lib/engine/core.ts` — `BYTES_PER_SAMPLE`, `frameBytes()`, `EngineRuntimeConfig`.
- `lib/engine/utils.ts` — `encodeToInt16()` (Float32 플래너 → Int16 인터리브, 웹 캡처 경로용).
- `lib/codec/wav-encoder.ts` — `pcmFramesToWavBlob()` (저장/내보내기용 WAV 인코딩).
- `components/calibration/CalibrationContext.tsx` — `useCalibration()`으로 `sampleRate`/`bufferSize`/`channels`/`captureDeviceUID`/`inputDeviceId`/`inputDeviceLabel`/`outputDeviceId`를 읽는다 (읽기 전용).
- `features/audio/types.ts` — `AnalysisFrame`/`AppStatus`/`InputParameterValues`.
- `shared/lib/utils.ts`(`cn`/`formatTime`), `wavesurfer.js`(동적 import), `lucide-react`, `public/mic-processor.js`(워클릿 모듈 URL 로드).
- Electron 브리지 `window.audioCapture`(`shared/types/electron-bridge.d.ts`) — 네이티브 캡처 시작/정지 + `onData`/`onEnded` 이벤트.

이 도메인을 import하는 외부(방향: 대상 → player): `dashboard/DashboardClient.tsx`(컴포넌트 + 핸들).

내부 처리 흐름 — 파일 경로:

```
audioFile → WaveSurfer 재생 (setSinkId 출력 라우팅) — 파일 PCM은 엔진에 직접 보내지 않음
  → 최초 재생 시 useCaptureSession.start()
  → (아래 캡처 경로와 동일) 하드웨어 ch0(V)/ch1(I) 캡처 → 엔진
  → "frame" 수신 → onFrameReceived → DashboardClient
  → 일시정지: pauseRecording (세션 유지) / 정지: cleanup
```

내부 처리 흐름 — 캡처 경로(파일·마이크 공통, useCaptureSession.start):

```
window.audioCapture 존재?
 ├─ 예: useNativeCapture.start() → 헬퍼 capture 상주 → onData 청크(N채널 int16 인터리브)
 │       → createNativeFrameReframer ─ onFrame(2ch V/I) → ws.send → 엔진
 │                                   └ onRawFrame(전 채널) → rawCaptureRef 세션 버퍼 → 저장 시 WAV
 └─ 아니오: useWebAudioWorkletCapture.start() → getUserMedia → mic-processor 워클릿
         → encodeToInt16 → ws.send → 엔진
(공통) openAnalysisSocket의 onmessage(ready→playing / frame→onFrameReceived / error) → DashboardClient
```

어떤 경로에서도 입력 PCM 프레임을 드롭·스킵·재정렬하지 않는다(온도 모델이 상태 누적형). 일시정지는 세션을 끊지 않고 데이터 흐름만 멈추므로, 재개 시 WASM 온도 누적 상태와 차트 시간축이 정지 지점부터 이어진다.

## 5. 주요 인터페이스 / 진입점

- `WaveformPlayer` (default export) → `forwardRef<WaveformPlayerHandle, Props>` 컴포넌트 → 파일 재생 + 캡처 분석 UI. 재생은 WaveSurfer, 분석은 `useCaptureSession`이 담당하며 파일 자체를 디코딩해 분석하지 않는다.
- `WaveformPlayerHandle` → `{ sendMessage(msg: object): void; pause(): void; exportRecordedAudio(): Blob | null; subscribeCaptureStream(fn: CaptureStreamListener): () => void }` → 상위(DashboardClient)가 ref로 제어하는 핸들. `pause()`는 캡처 세션을 닫지 않아(저장 버퍼만 멈춤) 재개 시 차트가 보존되고, `exportRecordedAudio()`는 원본 파일이 아니라 세션이 실제 캡처한 전 채널 PCM을 WAV로 반환한다(캡처된 적 없으면 null). `subscribeCaptureStream()`은 원본 캡처 청크 실시간 스트림 구독(구독 해제 함수 반환)으로, `MicrophonePlayerHandle`과 같은 계약이라 파일·마이크 모드에서 `ChartDetailOverlay` 채널 뷰가 같은 방식으로 실시간 갱신된다.
- `MicrophonePlayer` (default export) → 라이브 캡처 컴포넌트. `onSaveRecording?: (rec: MicRecordingExport) => Promise<void> | void`를 주면 정지 후 "저장" 버튼이 나타난다.
- `MicRecordingExport` = `CaptureRecordingExport` → `{ blob: Blob; channels: number; sampleRate: number; durationSec: number }` → N채널 인터리브 int16 WAV(ch0=V, ch1=I, ch2.. 확장 채널) 내보내기 페이로드.
- `useCaptureSession(deps: UseCaptureSessionDeps)` → `{ start, stop, cleanup, isRecording, micError, sampleRate, deviceName, actualBufferSize, actualLatency, saveRecording, hasRecording, saving, recordingChannels, getRecordedBlob, sendMessage, pauseRecording, resumeRecording, frameCountRef, framesRcvdRef }` → 파일·마이크 공용 캡처+분석+녹음 세션. `start()`는 `window.audioCapture` 존재 시 네이티브, 부재 시 getUserMedia 폴백을 고른다. `getRecordedBlob()`은 세션 버퍼를 동기적으로 WAV Blob으로 반환(호출자가 저장 파이프라인을 직접 소유할 때, WaveformPlayer용), `saveRecording()`은 `onSaveRecording` 콜백으로 넘긴다(MicrophonePlayer용).
- `CaptureRecordingExport` (`useCaptureSession.ts`) → 위 `MicRecordingExport`와 동일 구조 — 저장 요청 시 상위로 넘기는 전 채널 캡처 페이로드.
- `buildInitMessage(inputParams: InputParameterValues | undefined, config: EngineRuntimeConfig): string` → init JSON 문자열.
- `useNativeCapture(deps: NativeCaptureDeps)` → `{ start(params: NativeCaptureParams): Promise<void> }` → `channels`는 최소 2로 보정, `captureDeviceUID` 빈 문자열이면 OS 기본 입력. Electron 전용(브리지 부재 시 throw).
- `useWebAudioWorkletCapture(deps: WebCaptureDeps)` → `{ start(params: WebCaptureParams): Promise<void> }` → 요청 `bufferSize`는 워클릿이 그대로 지키지만 sampleRate/latency는 브라우저 협상값이다.
- `createNativeFrameReframer(captureChannels: number, wireSamplesPerCh: number, onFrame: (frame: Int16Array) => void, onRawFrame?: (rawFrame: Int16Array) => void)` → `(chunk: Uint8Array) => void` → 주의: `onFrame`/`onRawFrame`에 넘어오는 `Int16Array`는 재사용 버퍼라 호출자가 즉시 복사(`slice(0)`)해야 한다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-09: WaveformPlayer/MicrophonePlayer 캡처 세션 통합 반영 — `stream/{usePcmDecoder,useAnalysisStream,useBatchAnalysis}` 삭제, `capture/useCaptureSession.ts`(파일·마이크 공용 캡처+분석+녹음 세션) 신규. 파일 모드가 파일 PCM 직접 분석 대신 WaveSurfer 재생 + 하드웨어 V/I 캡처를 공유하도록 변경, 배치 분석 제거, `WaveformPlayerHandle`에서 `runBatchAnalysis`/`stopStreaming` 제거. 섹션 1·2·3·4·5 갱신 (커밋 범위: e0add14..HEAD, 워크트리 포함)
- 2026-07-10: `WaveformPlayerHandle`에 `subscribeCaptureStream` 추가 — 파일 모드에서 `DashboardClient.subscribeChannelStream`이 호출될 때 이 핸들 메서드가 없어 런타임 크래시가 나던 잠복 버그를 수정. `WaveformPlayer`는 이미 `useCaptureSession`을 공유하므로 세션의 `subscribeCaptureStream`을 그대로 핸들에 노출(마이크 모드와 동일 계약). 섹션 3·5 부분 갱신 (커밋 범위: 537099f..HEAD, 워크트리 포함)
- 2026-07-14: 와이어/캡처 PCM 샘플 폭을 int32에서 int16으로 통일한 것을 반영 — 와이어 프레임이 인터리브 Int16(`BYTES_PER_SAMPLE`=2바이트)이 되어 기본 프레임 크기가 3840→1920 bytes/frame. 웹 폴백은 `encodeToInt16`으로, 네이티브 청크·`createNativeFrameReframer`는 int16(`Int16Array` 콜백)으로 바뀌었고, 전 채널 저장 WAV(`MicRecordingExport`)도 int16이다. 섹션 1·3·4·5 부분 갱신 (커밋되지 않은 워크트리 변경 반영)
