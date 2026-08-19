# player

## 1. 도메인 설명

파일 재생과 실제 하드웨어 캡처를 하나의 세션으로 묶는 도메인입니다. 이 앱에서 재생 버튼을 누르면 실제로는 재생과 캡처가 하나의 IOProc으로 함께 돌아갑니다. 엔진에는 원본 파일 PCM을 보호 대상(buf)으로, 캡처가 돌려준 V/I 프레임을 실측 센싱으로 짝지어 보냅니다. 기본 모드(Protected)에서는 엔진이 돌려준 보호 PCM이 그대로 스피커 출력이 됩니다. 재생과 캡처가 같은 클록을 공유하므로 진행바 위치도 수신한 캡처 프레임 수로만 계산합니다.

## 2. 프로젝트 전반에서의 역할

`engine/`의 `EngineClient`를 열고 Tauri 네이티브 캡처/재생캡처 브리지(`window.audioCapture`/`audioPlayCapture`)를 구동해 그 결과를 프레임 단위로 `dashboard/`에 올려보내는 중간 계층입니다. UI 표현(`PlayerBar.tsx`)과 세션 로직(`capture/` 아래 훅들)이 나뉘어 있어 `DuplexFilePlayer.tsx`는 둘을 잇는 역할만 합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `DuplexFilePlayer.tsx` | 파일 디코드 + 캡처 세션 훅 연결 + 진행바 UI 조립. Protected/Original 재생 모드 상태를 소유하고 `WaveformPlayerHandle`을 ref로 노출 |
| `PlayerBar.tsx` | 순수 프레젠테이션 셸 — 재생/정지/저장/리셋 버튼과 시간 표시에 더해 Protected/Original 토글 버튼(재생·연결 중에는 잠김), 가운데 슬롯(children)에 진행바를 받음 |
| `capture/useCaptureSession.ts` | `EngineClient` 열기와 콜백 배선, 원본/보호 두 녹음 버퍼(`PcmFrameStore`) 관리를 총괄하는 최상위 세션 훅 |
| `capture/useNativeCapture.ts` | 네이티브 브리지 구동(`window.audioCapture`/`audioPlayCapture`) + 엔진 wire 프레임(`[원본 buf ‖ 실측 센싱]`) 조립 + Protected 스트리밍의 크레딧 루프와 보호 PCM 배치 전송 |
| `capture/reframeNativeChunk.ts` | N채널 인터리브 int16 청크를 고정 크기 ch0(V)/ch1(I) 분석 프레임으로 재구성하면서 전 채널 원본도 함께 보존 |
| `capture/types.ts` | `CaptureStreamEvent`/`CaptureSnapshot`/`WaveformPlayerHandle`/`PlaybackMode`/`PlaybackStreamPump` 등 이 도메인의 공유 타입 |

## 4. 의존성 및 흐름

- **가져오는 것**: `calibration/CalibrationContext`, `shared/components/error-popup`, `lib/engine/{core, protocol/engine-client, utils}`, `lib/codec/{playback-decode, wav-encoder}`, `lib/pcm-frame-store`, `shared/lib/ipc-error`, `shared/lib/iron-perf`.
- **Tauri 네이티브 브리지**: `window.audioCapture`/`window.audioPlayCapture`(`shared/lib/tauri-bridge`가 채움)를 직접 호출합니다.
- **소비하는 도메인**: `dashboard/`가 `DuplexFilePlayer`를 마운트하고 `onFrameReceived`/`onStreamStart`/`onSave`/`onReset` 등 콜백을 주입합니다. 저장 시에는 `exportRecordedAudio()`/`exportProtectedAudio()`를 호출합니다. `channel/`(`useProtectedCompareStreams` 등)은 `WaveformPlayerHandle`의 `subscribeCaptureStream`/`getDecodedPlayback`으로 캡처·보호 스트림을 구독합니다.

```
파일 업로드 → decodeFileToStereo() → 인터리브 스테레오 PCM
"재생" 클릭 → useCaptureSession.start({ playbackPcm }) → useNativeCapture.start()
    → Protected(기본): window.audioPlayCapture.start({ stream: true, prefillMs: 40 })
      Original:        4MiB 청크 핸드셰이크로 ref 업로드 후 start({ refWriteId, refChannels: 2 })
    → onData(chunk) → reframe() → 캡처 프레임 1개 = 엔진 투입 크레딧 1개
        → [원본 파일 프레임 ‖ 최신 캡처 프레임]을 EngineClient.sendFrame()
        → onFrame → onFrameReceived(dashboard로 전달)
        → onProtectedPcm → (Protected) writePcm()을 10ms 배치로 헬퍼 링 버퍼에 전송, 완료 시 control("end")

진행바 위치 = 수신한 캡처 프레임 수 ÷ sampleRate (재생 시각이 아니라 캡처 시각 기준 — 단일 클록)
```

Protected 경로의 엔진 선행분은 `프리필 40ms + 쓰기 배치 10ms` 프레임 수로 제한합니다(`producedFrames − capturedFrames < leadFrames`). 헬퍼가 exit 4(프리필 시간 내 보호 PCM 미도착)나 exit 3(장치 분리)으로 끝나면 각각 사용자용 오류 문구로 매핑합니다.

## 5. 주요 인터페이스 / 진입점

- **`DuplexFilePlayer`** — `forwardRef` 컴포넌트. `audioFile`/`status`/`onStatusChange`/`onFrameReceived`/`onStreamStart` 등을 props로 받고 ref로 `WaveformPlayerHandle`을 노출합니다.
- **`WaveformPlayerHandle`** — `exportRecordedAudio(): Blob | null` / `exportProtectedAudio(): Blob | null` / `getCaptureSnapshot(): CaptureSnapshot | null` / `subscribeCaptureStream(fn): () => void` / `getDecodedPlayback(): DecodedPlayback | null`. (`sendMessage`/`pause`는 제거)
- **`useCaptureSession(deps): { start, cleanup, micError, getRecordedBlob, getProtectedBlob, getCaptureSnapshot, pauseRecording, resumeRecording, subscribeCaptureStream }`** — 이 도메인의 핵심 훅. `deps.playbackMode`(기본 `"protected"`)가 재생 경로를 정합니다.
- **`useNativeCapture(deps).start(params: NativeCaptureParams)`** — `params.playback`이 있으면 play-capture 경로(`playback.mode === "original"`이면 ref 업로드, 아니면 스트리밍), 없으면 순수 capture 경로. 장치가 적용한 SampleRate가 요청과 1 Hz 이상 다르면 세션을 중단하고 오류를 던집니다.
- **`createNativeFrameReframer(captureChannels, wireSamplesPerCh, onFrame, onRawFrame?)`** — 청크 하나가 아니라 이어지는 스트림을 받아 고정 크기 프레임 단위로 잘라 콜백합니다.
- **`CaptureStreamEvent`** — `{type:"reset", channels, sampleRate} | {type:"chunk", chunk: Int16Array, channels, sampleRate} | {type:"protected", frameIndex, input, processed, sampleRate}`.
- **`CaptureSnapshot`** — `{ channels, sampleRate, pcm: PcmFrameStore, samplesPerFrame, totalFrames }`. 복사 없이 세션의 녹음 버퍼를 그대로 참조합니다(O(1)).
- **`PlaybackMode`** — `"protected" | "original"`. **`PlaybackStreamPump`** — `{ onEngineReady(), pushProtected(processed) }`, `useCaptureSession`과 `useNativeCapture` 사이의 보호 PCM 전달 다리.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. `PlayerBar.tsx`(프레젠테이션 셸 분리)는 이미 추출돼 있고, 네이티브 브리지는 Electron이 아니라 Tauri(`window.audioCapture`/`audioPlayCapture`)로 전환을 마친 상태를 반영했습니다. (커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: 스피커 출력을 ff_prot 통과본으로 바꾸는 Protected 스트리밍 재생을 기본값으로 도입 — `PlayerBar`에 Protected/Original 토글 추가, `useNativeCapture`가 엔진 wire 프레임(`[원본 buf ‖ 실측 센싱]` 2배 길이) 조립과 40 ms 프리필/10 ms 배치의 크레딧 루프를 직접 소유하고, Original 모드 ref 업로드는 4 MiB 청크 핸드셰이크로 변경. 분석 소켓(`SocketLike`)·`build-init-message.ts` 제거 → `EngineClient` 직접 사용, 녹음 버퍼는 `lib/pcm-frame-store`의 `PcmFrameStore`로 이관, `WaveformPlayerHandle`에서 `sendMessage`/`pause` 제거·`getDecodedPlayback` 추가. (커밋 범위: a465514..24d1daa)
