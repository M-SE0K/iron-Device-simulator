# player

## 1. 도메인 설명

파일 재생과 실제 하드웨어 캡처를 하나의 세션으로 묶는 도메인입니다. 이 앱에서 재생 버튼을 누르면 실제로는 재생과 캡처가 하나의 IOProc으로 함께 돌아가고, 그 캡처가 돌려주는 신호를 분석합니다. 재생과 캡처가 같은 클록을 공유하므로 진행바 위치도 수신한 캡처 프레임 수로만 계산합니다.

## 2. 프로젝트 전반에서의 역할

`engine/`의 `SocketLike` 분석 소켓을 열고, Tauri 네이티브 캡처/재생캡처 브리지(`window.audioCapture`/`audioPlayCapture`)를 구동해 그 결과를 프레임 단위로 `dashboard/`에 올려보내는 중간 계층입니다. UI 표현(`PlayerBar.tsx`)과 세션 로직(`capture/` 아래 훅들)이 나뉘어 있어 `DuplexFilePlayer.tsx`는 둘을 잇는 역할만 합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `DuplexFilePlayer.tsx` | 파일 디코드 + 캡처 세션 훅 연결 + 진행바 UI 조립. `WaveformPlayerHandle`을 ref로 노출 |
| `PlayerBar.tsx` | 순수 프레젠테이션 셸 — 재생/정지/저장/리셋 버튼과 시간 표시만 담당, 가운데 슬롯(children)에 진행바를 받음 |
| `capture/useCaptureSession.ts` | 분석 소켓 열기, 메시지 핸들링, 녹음 버퍼 관리를 총괄하는 최상위 세션 훅 |
| `capture/useNativeCapture.ts` | 네이티브 캡처/재생캡처 브리지 구동(`window.audioCapture`/`audioPlayCapture`) |
| `capture/reframeNativeChunk.ts` | N채널 인터리브 int16 청크를 고정 크기 ch0(V)/ch1(I) 분석 프레임으로 재구성하면서 전 채널 원본도 함께 보존 |
| `capture/build-init-message.ts` | 분석 소켓의 `"init"` 제어 메시지 조립 |
| `capture/types.ts` | `CaptureStreamEvent`/`CaptureSnapshot`/`WaveformPlayerHandle` 등 이 도메인의 공유 타입 |

## 4. 의존성 및 흐름

- **가져오는 것**: `calibration/CalibrationContext`, `shared/components/error-popup`, `lib/engine/{core, protocol/local-socket, protocol/socket-types, protocol/analysis, utils}`, `lib/codec/{playback-decode, wav-encoder}`, `lib/perf/capture-telemetry`, `lib/perf-e2e/collector`, `shared/lib/ipc-error`.
- **Tauri 네이티브 브리지**: `window.audioCapture`/`window.audioPlayCapture`(`shared/lib/tauri-bridge`가 채움)를 직접 호출합니다.
- **소비하는 도메인**: `dashboard/`가 `DuplexFilePlayer`를 마운트하고 `onFrameReceived`/`onStreamStart`/`onSave`/`onReset` 등 콜백을 주입합니다. `channel/`(`ChartDetailOverlay`, `ProtectedComparePanel`)과 `workspace/`(저장 시 `getRecordedBlob`)는 `WaveformPlayerHandle`로 캡처 스트림·스냅샷·녹음 Blob을 가져갑니다.

```
파일 업로드 → decodeFileToStereo() → 인터리브 스테레오 PCM
"재생" 클릭 → useCaptureSession.start({ playbackPcm }) → useNativeCapture.start()
    → window.audioPlayCapture.start(...) (단일 IOProc, 재생+캡처 동시)
    → onData(chunk) → reframe() → ch0/ch1 분석 프레임 생성 + 원본 채널 보존
    → createAnalysisSocket()으로 분석 → onmessage("frame") → onFrameReceived(dashboard로 전달)

진행바 위치 = 수신한 캡처 프레임 수 ÷ sampleRate (재생 시각이 아니라 캡처 시각 기준 — 단일 클록)
```

## 5. 주요 인터페이스 / 진입점

- **`DuplexFilePlayer`** — `forwardRef` 컴포넌트. `audioFile`/`status`/`onStatusChange`/`onFrameReceived`/`onStreamStart` 등을 props로 받고 ref로 `WaveformPlayerHandle`을 노출합니다.
- **`WaveformPlayerHandle`** — `sendMessage(msg)` / `pause()` / `exportRecordedAudio(): Blob | null` / `exportProtectedAudio(): Blob | null` / `getCaptureSnapshot(): CaptureSnapshot | null` / `subscribeCaptureStream(fn): () => void`.
- **`useCaptureSession(deps): { start, stop, cleanup, isRecording, micError, sampleRate, deviceName, actualBufferSize, getRecordedBlob, getCaptureSnapshot, sendMessage, pauseRecording, resumeRecording, getProtectedBlob, hasProtectedRecording, subscribeCaptureStream }`** — 이 도메인의 핵심 훅.
- **`useNativeCapture(deps).start(params: NativeCaptureParams)`** — `params.playback`이 있으면 play-capture 경로, 없으면 순수 capture 경로로 네이티브 브리지를 엽니다.
- **`createNativeFrameReframer(captureChannels, wireSamplesPerCh, onFrame, onRawFrame?)`** — 청크 하나가 아니라 이어지는 스트림을 받아 고정 크기 프레임 단위로 잘라 콜백합니다.
- **`buildInitMessage(inputParams, config: EngineRuntimeConfig): string`** — 분석 소켓에 보낼 `"init"` JSON 문자열을 만듭니다.
- **`CaptureStreamEvent`** — `{type:"reset"} | {type:"chunk", chunk, channels, sampleRate} | {type:"protected", frameIndex, input, processed, sampleRate}`.
- **`CaptureSnapshot`** — `{ channels, sampleRate, frames: readonly ArrayBuffer[], samplesPerFrame, totalFrames }`. 복사 없이 세션의 원본 프레임 배열을 그대로 참조합니다(O(1)).

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. `PlayerBar.tsx`(프레젠테이션 셸 분리)는 이미 추출돼 있고, 네이티브 브리지는 Electron이 아니라 Tauri(`window.audioCapture`/`audioPlayCapture`)로 전환을 마친 상태를 반영했습니다. (커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
