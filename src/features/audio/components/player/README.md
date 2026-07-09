# player

## 1. 도메인 설명

오디오 입력(업로드 파일·마이크/네이티브 캡처)을 WASM(WebAssembly) 분석 엔진이 소비하는 인터리브 Int32 PCM 프레임으로 바꿔 흘려보내고 엔진이 돌려주는 온도·익스커션 프레임을 대시보드로 전달하는 입력 계층이다. 개발자는 이 도메인만 보면 "소리가 어떻게 분석 프레임이 되는가"의 전 과정을 파악할 수 있다.

두 오케스트레이터 컴포넌트가 도메인의 얼굴이다. `WaveformPlayer.tsx`는 파일 재생(WaveSurfer) 경로를, `MicrophonePlayer.tsx`는 라이브 캡처 경로를 담당하며 각각 하위 `stream/`(디코딩·실시간 전송·배치 분석)과 `capture/`(네이티브 CoreAudio·웹 AudioWorklet 캡처) 훅 모음을 조합한다. 두 컴포넌트 모두 `createAnalysisSocket()`이 돌려주는 WebSocket 모양의 인프로세스 소켓(`LocalWasmSocket`)에 대고 쓰기 때문에, 코드가 WebSocket API 형태여도 데이터는 페이지 밖으로 나가지 않는다.

와이어 프레임 포맷은 인터리브 Int32(L R L R, `BYTES_PER_SAMPLE` = 4바이트)이고, 기본 설정(48 kHz, 480 samples/ch)에서 프레임 1개는 480 × 2ch × 4바이트 = **3840 bytes/frame**, 10 ms 분량이다. `sampleRate`/`bufferSize`는 Calibration UI 값이 세션 시작 시점에 `EngineRuntimeConfig`로 고정되므로 고정 상수가 아니다.

## 2. 프로젝트 전반에서의 역할

`DashboardClient.tsx`(`components/dashboard/`)가 두 플레이어를 모두 마운트하고, 플레이어가 올려보내는 `AnalysisFrame`(`onFrameReceived`)을 출력 큐/FIFO를 거쳐 Temperature/Excursion 차트로 렌더링한다. 즉 이 도메인은 프로젝트 데이터 흐름의 최상류(입력 → 분석 요청)를 담당하고, 하류(수신 프레임의 코얼레싱·이벤트 검출·차트)는 `dashboard/` + `lib/render/`가 담당한다.

- 실시간 모드: `WaveformPlayer`의 rAF 루프가 `WaveSurfer.getCurrentTime()`을 마스터 클록으로 삼아 재생 시각까지의 미전송 프레임을 소켓에 전송한다.
- 배치 모드: `DashboardClient`가 `WaveformPlayerHandle.runBatchAnalysis()`를 호출해 전체 파일을 재생 동기화 없이 별도 소켓으로 분석한다.
- 마이크 모드: `MicrophonePlayer`가 자체 소켓을 열고 캡처 청크를 같은 `onFrameReceived` 콜백으로 흘려보낸다.
- V/I 센싱: 네이티브 캡처 경로는 채널 의미를 ch0 = V(전압 센스), ch1 = I(전류 센스)로 확정해 이 두 채널만 엔진에 보내고 Calibration에서 확장한 나머지 채널(ch2..chN-1)은 세션 버퍼에 보존했다가 "저장" 시 전 채널 WAV로 내보낸다.

외부에서 이 도메인을 import하는 파일은 `components/dashboard/DashboardClient.tsx`(두 플레이어 + `WaveformPlayerHandle`/`MicRecordingExport`)와 `components/dashboard/hooks/useRenderTelemetry.ts`(`WaveformPlayerHandle` 타입만) 두 곳이다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `WaveformPlayer.tsx` | 파일 재생 오케스트레이터. WaveSurfer 생성/파괴, 재생 컨트롤 UI, `calibration.outputDeviceId`에 따른 `setSinkId()` 출력 라우팅을 담당하고 실제 파이프라인은 `stream/` 훅 3개에 위임한다. ref로 `WaveformPlayerHandle`(`sendMessage`/`runBatchAnalysis`/`stopStreaming`/`pause`/`exportRecordedAudio`) 노출. |
| `MicrophonePlayer.tsx` | 라이브 캡처 오케스트레이터. 자체 분석 소켓(`openAnalysisSocket`)과 공통 메시지 핸들러를 소유하고 `window.audioCapture` 존재 시 항상 네이티브 캡처, 부재 시(웹/모바일) getUserMedia 폴백을 선택한다. 정지 후 세션 버퍼(`rawCaptureRef`)의 전 채널 PCM을 WAV로 인코딩해 `onSaveRecording`으로 상위에 넘기는 "저장" 버튼 포함. |
| `stream/usePcmDecoder.ts` | 업로드 파일을 `new AudioContext({ sampleRate })`로 디코딩해 `encodeToInt32()` 인터리브 후 `frameBytes(config)` 단위(기본 3840바이트)로 잘라 `pcmFramesRef`에 적재한다. 디코딩 시작 시점의 calibration 값으로 세션 `EngineRuntimeConfig`를 고정한다. |
| `stream/useAnalysisStream.ts` | 실시간 스트림 훅. 소켓 open/close/reset, `WaveSurfer.getCurrentTime()` 기준 rAF 전송 루프, RTT(최근 100샘플)·전송률(1초 윈도우)·디버그 텔레메트리(100 ms 스로틀 flush)를 담당한다. `pauseStream()`은 소켓을 유지한 채 rAF만 멈춰 재개 시 차트를 보존한다. |
| `stream/useBatchAnalysis.ts` | 배치 분석 훅. 디코딩된 전체 PCM을 별도 소켓으로 순차 전송(`bufferedAmount` > 4 MB면 4 ms 대기하는 백프레셔)하고 수신 프레임을 frameIdx로 정렬한 `AnalysisFrame[]`을 Promise로 반환한다. 조기 close 시 부분 결과로도 resolve한다. |
| `stream/buildInitMessage.ts` | 분석 소켓 `init` 메시지(JSON: `ampOutputPower`/`speakerModel`/`ambientTemp`/`sampleRate`/`bufferSize`) 빌더. `useAnalysisStream`과 `useBatchAnalysis`가 공유한다. |
| `capture/useNativeCapture.ts` | Electron CoreAudio 캡처 경로. `window.audioCapture.start()`로 상주 헬퍼를 띄우고 장치가 실제 적용한 `actual.sampleRate`/`actual.bufferSize`를 우선해 소켓 init에 반영한다("actual 우선" 원칙 — 이 값이 `ff_prot_start_exec`의 dt 계산에 쓰인다). 청크는 reframer를 거쳐 2ch(V/I) 분석 프레임과 전 채널 원본 프레임으로 분기된다. |
| `capture/useWebAudioWorkletCapture.ts` | 웹/모바일 폴백 캡처 경로. getUserMedia(`echoCancellation`/`noiseSuppression`/`autoGainControl` 모두 off, `inputDeviceId` 지정 시 `deviceId: { exact }`) → `/mic-processor.js` AudioWorklet(`processorOptions.samplesPerCh` 청킹) → `encodeToInt32()` → 소켓 전송. BufferSize는 Chromium이 주인이라 latency 힌트만 전달한다. |
| `capture/reframeNativeChunk.ts` | `createNativeFrameReframer()` — N채널 인터리브 int32 청크를 `wireSamplesPerCh` 프레임 경계로 재구성하는 순수 함수(훅 아님). 미완성 device-frame 잔여 바이트(`pending`)와 미완성 출력 프레임(`outCount`)을 내부 이월해 경계를 유지하고 ch0/ch1을 `onFrame`으로, 전 채널 원본을 `onRawFrame`으로 방출한다. |

## 4. 의존성 및 흐름

이 도메인이 import하는 모듈(방향: player → 대상):

- `lib/engine/protocol/local-socket.ts` — `createAnalysisSocket()`/`SocketLike`. PCM 프레임을 보내고 `frame` 메시지를 받는 유일한 분석 창구.
- `lib/engine/core.ts` — `DEFAULT_ENGINE_CONFIG`, `frameBytes()`, `EngineRuntimeConfig`, `BYTES_PER_SAMPLE`.
- `lib/engine/utils.ts` — `encodeToInt32()` (Float32 플래너 → Int32 인터리브).
- `lib/wav-encoder.ts` — `pcmFramesToWavBlob()` (저장/내보내기용 WAV 인코딩).
- `components/calibration/CalibrationContext.tsx` — `useCalibration()`으로 `sampleRate`/`bufferSize`/`channels`/`captureDeviceUID`/`inputDeviceId`/`outputDeviceId`를 읽는다 (읽기 전용).
- `features/audio/types.ts` — `AnalysisFrame`/`AppStatus`/`InputParameterValues`, `lib/debug/types.ts` — `StreamDebugInfo`/`DebugLogEntry`.
- `shared/lib/utils.ts`(`cn`/`formatTime`), `wavesurfer.js`(동적 import), `lucide-react`, `public/mic-processor.js`(워클릿 모듈 URL 로드).
- Electron 브리지 `window.audioCapture`(`shared/types/electron-bridge.d.ts`) — 네이티브 캡처 시작/정지 + `onData`/`onEnded` 이벤트.

이 도메인을 import하는 외부(방향: 대상 → player): `dashboard/DashboardClient.tsx`(컴포넌트 + 핸들), `dashboard/hooks/useRenderTelemetry.ts`(타입만).

내부 처리 흐름 — 파일 경로:

```
audioFile → usePcmDecoder (AudioContext 디코딩 → encodeToInt32 → 3840B 프레임 청킹, pcmFramesRef)
  → useAnalysisStream.open() → createAnalysisSocket → init(buildInitMessage) → "ready"
  → rAF 루프: WaveSurfer.getCurrentTime() 기준 미전송 프레임 ws.send()
  → "frame" 수신 → RTT 계산 → onFrameReceived / onDebugUpdate / onDebugLog → DashboardClient
```

내부 처리 흐름 — 마이크/네이티브 경로:

```
window.audioCapture 존재?
 ├─ 예: useNativeCapture.start() → 헬퍼 capture 상주 → onData 청크(N채널 int32 인터리브)
 │       → createNativeFrameReframer ─ onFrame(2ch V/I) → ws.send → 엔진
 │                                   └ onRawFrame(전 채널) → rawCaptureRef 세션 버퍼 → 저장 시 WAV
 └─ 아니오: useWebAudioWorkletCapture.start() → getUserMedia → mic-processor 워클릿
         → encodeToInt32 → ws.send → 엔진
(공통) MicrophonePlayer.openAnalysisSocket의 onmessage → onFrameReceived → DashboardClient
```

배치 경로는 `useBatchAnalysis.runBatchAnalysis()`가 별도 소켓으로 전체 프레임을 백프레셔만 고려해 순차 전송하고 결과 배열을 반환한다. 어떤 경로에서도 입력 PCM 프레임을 드롭·스킵·재정렬하지 않는다(온도 모델이 상태 누적형).

## 5. 주요 인터페이스 / 진입점

- `WaveformPlayer` (default export) → `forwardRef<WaveformPlayerHandle, Props>` 컴포넌트 → 파일 재생 + 실시간/배치 분석 UI. `enableStreaming={false}`면 재생 시 스트리밍 없이 오디오만 재생한다(배치 모드용).
- `WaveformPlayerHandle` → `{ sendMessage(msg: object): void; runBatchAnalysis(onProgress?: (done, total) => void): Promise<AnalysisFrame[]>; stopStreaming(): void; pause(): void; exportRecordedAudio(): Blob | null }` → 상위(DashboardClient)가 ref로 제어하는 핸들. `pause()`는 소켓을 닫지 않아 재개 시 차트가 보존되고, `exportRecordedAudio()`는 원본 파일이 아니라 현재 재생 시점까지 실제 분석된 프레임만 WAV(2ch)로 반환한다(미디코딩/미재생 시 null).
- `MicrophonePlayer` (default export) → 라이브 캡처 컴포넌트. `onSaveRecording?: (rec: MicRecordingExport) => Promise<void> | void`를 주면 정지 후 "저장" 버튼이 나타난다.
- `MicRecordingExport` → `{ blob: Blob; channels: number; sampleRate: number; durationSec: number }` → N채널 인터리브 int32 WAV(ch0=V, ch1=I, ch2.. 확장 채널) 내보내기 페이로드.
- `usePcmDecoder(audioFile: File | null, sampleRate: string, bufferSize: string)` → `{ pcmFramesRef, pcmReadyRef, engineConfigRef, displayConfig }` → 파일 디코딩+프레임 청킹. 반환값이 state가 아닌 ref 중심이라 rAF 루프가 리렌더 없이 소비한다.
- `useAnalysisStream(deps: UseAnalysisStreamDeps)` → `{ open, close, reset, pauseStream, sendMessage }` → 실시간 스트림 제어. `open()`은 이미 열린 소켓이면 rAF만 재시작한다(재연결 없음 → `onStreamStart` 미호출, 차트 유지).
- `useBatchAnalysis(deps: UseBatchAnalysisDeps)` → `{ runBatchAnalysis }` → PCM 미준비 시 reject. 진행률 콜백은 50프레임마다 호출된다.
- `buildInitMessage(inputParams: InputParameterValues | undefined, config: EngineRuntimeConfig): string` → init JSON 문자열.
- `useNativeCapture(deps: NativeCaptureDeps)` → `{ start(params: NativeCaptureParams): Promise<void> }` → `channels`는 최소 2로 보정, `captureDeviceUID` 빈 문자열이면 OS 기본 입력. Electron 전용(브리지 부재 시 throw).
- `useWebAudioWorkletCapture(deps: WebCaptureDeps)` → `{ start(params: WebCaptureParams): Promise<void> }` → 요청 `bufferSize`는 워클릿이 그대로 지키지만 sampleRate/latency는 브라우저 협상값이다.
- `createNativeFrameReframer(captureChannels: number, wireSamplesPerCh: number, onFrame: (frame: Int32Array) => void, onRawFrame?: (rawFrame: Int32Array) => void)` → `(chunk: Uint8Array) => void` → 주의: `onFrame`/`onRawFrame`에 넘어오는 `Int32Array`는 재사용 버퍼라 호출자가 즉시 복사(`slice(0)`)해야 한다.

## 6. 변경 이력(요약)
- 2026-07-09: 최초 작성 (기준 커밋: 1fbbf44, 커밋되지 않은 워크트리 변경 반영)
