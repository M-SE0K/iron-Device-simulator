# player

## 1. 도메인 설명

파일 재생과 실제 하드웨어 캡처를 하나의 세션으로 묶는 도메인입니다. 이 앱에서 재생 버튼을 누르면 실제로는 재생과 캡처가 하나의 IOProc으로 함께 돕니다. 분석 대상은 그 캡처가 돌려주는 신호입니다. 재생과 캡처가 같은 클록을 공유하므로 진행바 위치도 수신한 캡처 프레임 수로만 계산합니다.

스피커로 나가는 신호는 업로드한 원본이 아닙니다. 기본 모드(`protected`)에서는 원본을 먼저 보호 알고리즘에 통과시키고 **그 결과만** 헬퍼에 밀어 넣습니다. 원본을 그대로 내보내는 `original` 모드는 같은 리그에서 보호 유/무를 비교하려고 남겨 둔 A/B 경로입니다.

## 2. 프로젝트 전반에서의 역할

`engine/`의 `SocketLike` 분석 소켓을 열고 Tauri 네이티브 캡처/재생캡처 브리지(`window.audioCapture`/`audioPlayCapture`)를 구동하는 중간 계층입니다. 그 결과는 프레임 단위로 `dashboard/`에 올려보냅니다. UI 표현(`PlayerBar.tsx`)과 세션 로직(`capture/` 아래 훅들)이 나뉘어 있어 `DuplexFilePlayer.tsx`는 둘을 잇는 역할만 합니다.

보호 스트리밍 재생 루프는 두 훅에 걸쳐 있습니다. 엔진 소켓과 그 응답은 `useCaptureSession`이 소유하고 "다음에 어느 원본 프레임을 넣을지"는 `useNativeCapture`만 압니다. 그래서 둘 사이를 `PlaybackStreamPump`라는 얇은 접점(`streamPumpRef`)으로 잇습니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `DuplexFilePlayer.tsx` | 파일 디코드 + 캡처 세션 훅 연결 + 진행바 UI 조립. 재생 모드 상태(기본 `protected`)를 소유하고, 세션이 살아 있는 동안(연결 중·재생·일시정지) 토글을 잠근다. `WaveformPlayerHandle`을 ref로 노출 |
| `PlayerBar.tsx` | 순수 프레젠테이션 셸 — 재생/정지/저장/리셋 버튼, 시간 표시, Protected/Original 토글 배지. 가운데 슬롯(children)에 진행바를 받음 |
| `capture/useCaptureSession.ts` | 분석 소켓 열기, 메시지 핸들링, 녹음 버퍼 관리를 총괄하는 최상위 세션 훅. 엔진이 돌려준 보호 PCM을 `streamPumpRef`로 재생 경로에 넘긴다 |
| `capture/useNativeCapture.ts` | 네이티브 캡처/재생캡처 브리지 구동(`window.audioCapture`/`audioPlayCapture`) + 보호 스트리밍 재생 루프(자기 클로킹 프레임 생산, 배치 쓰기, 종료 신호) |
| `capture/reframeNativeChunk.ts` | N채널 인터리브 int16 청크를 고정 크기 ch0(V)/ch1(I) 분석 프레임으로 재구성하면서 전 채널 원본도 함께 보존 |
| `capture/build-init-message.ts` | 분석 소켓의 `"init"` 제어 메시지 조립 |
| `capture/types.ts` | `PlaybackMode`/`PlaybackStreamPump`/`CaptureStreamEvent`/`CaptureSnapshot`/`WaveformPlayerHandle` 등 이 도메인의 공유 타입 |

## 4. 의존성 및 흐름

- **가져오는 것**: `calibration/CalibrationContext`, `shared/components/error-popup`, `lib/engine/{core, protocol/local-socket, protocol/socket-types, protocol/analysis, utils}`, `lib/codec/{playback-decode, wav-encoder}`, `shared/lib/ipc-error`.
- **Tauri 네이티브 브리지**: `window.audioCapture`/`window.audioPlayCapture`(`shared/lib/tauri-bridge`가 채움)를 직접 호출합니다. 보호 스트리밍 재생은 그중 `start({ stream: true, prefillMs })`와 `writePcm()`/`control("end")`을 씁니다.
- **소비하는 도메인**: `dashboard/`가 `DuplexFilePlayer`를 마운트하고 `onFrameReceived`/`onStreamStart`/`onSave`/`onReset` 등 콜백을 주입합니다. `channel/ProtectedComparePanel`과 `workspace/`(저장 시 `getRecordedBlob`), `channel/hooks/useChannelWaveStreams`는 `WaveformPlayerHandle`로 캡처 스트림·스냅샷·녹음 Blob을 가져갑니다. `capture/types.ts`의 타입은 `lib/render/raw-window.ts`도 참조합니다.

```
파일 업로드 → decodeFileToStereo() → 인터리브 스테레오 PCM
"재생" 클릭 → useCaptureSession.start({ playbackPcm }) → useNativeCapture.start()

[protected 모드 — 기본]
    → window.audioPlayCapture.start({ stream: true, prefillMs: 40 })  (선업로드 없음)
    → 엔진 "ready" → streamPumpRef.onEngineReady()로 프리필 생산
    → 엔진이 보호 PCM 반환 → streamPumpRef.pushProtected() → writePcm()으로 헬퍼 재생 링에 밀어넣기
    → 캡처 프레임 도착 = 실제 재생 위치 = 다음 원본 프레임을 넣을 크레딧(자기 클로킹)

[original 모드 — A/B 비교용]
    → uploadPlaybackRef()로 원본 전체 선업로드 → start({ refWriteId, refChannels: 2 })

공통: onData(chunk) → reframe() → ch0/ch1 분석 프레임 생성 + 원본 채널 보존
    → createAnalysisSocket()으로 분석 → onmessage("frame") → onFrameReceived(dashboard로 전달)

진행바 위치 = 수신한 캡처 프레임 수 ÷ sampleRate (재생 시각이 아니라 캡처 시각 기준 — 단일 클록)
```

## 5. 주요 인터페이스 / 진입점

- **`DuplexFilePlayer`** — `forwardRef` 컴포넌트. `audioFile`/`status`/`onStatusChange`/`onFrameReceived`/`onStreamStart` 등을 props로 받고 ref로 `WaveformPlayerHandle`을 노출합니다.
- **`WaveformPlayerHandle`** — `sendMessage(msg)` / `pause()` / `exportRecordedAudio(): Blob | null` / `exportProtectedAudio(): Blob | null` / `getCaptureSnapshot(): CaptureSnapshot | null` / `subscribeCaptureStream(fn): () => void`.
- **`PlaybackMode`** (type) — `"protected" | "original"`. 기본은 `protected`이고 ⚠️ **세션 시작 시점에만 반영됩니다** — 재생 중 전환은 엔진 상태와 클록 정합을 깨뜨리므로 UI에서 잠급니다.
- **`useCaptureSession(deps): { start, stop, cleanup, isRecording, micError, sampleRate, deviceName, actualBufferSize, getRecordedBlob, getCaptureSnapshot, sendMessage, pauseRecording, resumeRecording, getProtectedBlob, hasProtectedRecording, subscribeCaptureStream }`** — 이 도메인의 핵심 훅. `deps.playbackMode`를 생략하면 `protected`입니다.
- **`PlaybackStreamPump`** (type) — `{ onEngineReady(): void; pushProtected(processed: Int16Array): void }`. `useNativeCapture`가 세션 시작 때 `streamPumpRef`에 채우고 `useCaptureSession`이 호출합니다. `onEngineReady`는 프레임 카운터 리셋 **뒤에** 불러야 합니다(프레임 생산이 그 카운터를 올립니다).
- **`useNativeCapture(deps).start(params: NativeCaptureParams)`** — `params.playback`이 있으면 play-capture 경로, 없으면 순수 capture 경로로 네이티브 브리지를 엽니다. `params.playback.mode`가 `"original"`이 아니면 스트리밍 재생으로 갑니다.
- **`createNativeFrameReframer(captureChannels, wireSamplesPerCh, onFrame, onRawFrame?)`** — 청크 하나가 아니라 이어지는 스트림을 받아 고정 크기 프레임 단위로 잘라 콜백합니다.
- **`buildInitMessage(inputParams, config: EngineRuntimeConfig): string`** — 분석 소켓에 보낼 `"init"` JSON 문자열을 만듭니다.
- **`CaptureStreamEvent`** — `{type:"reset", channels, sampleRate} | {type:"chunk", chunk, channels, sampleRate} | {type:"protected", frameIndex, input, processed, sampleRate}`.
- **`CaptureSnapshot`** — `{ channels, sampleRate, frames: readonly ArrayBuffer[], samplesPerFrame, totalFrames }`. 복사 없이 세션의 원본 프레임 배열을 그대로 참조합니다(O(1)).

### 보호 스트리밍 재생의 상수와 규칙

- **프리필 `PLAYBACK_PREFILL_MS`(40 ms)** — 헬퍼가 소리를 내기 전에 링에 채워둘 분량. 렌더러 지터(GC·메인 스레드 정체)를 흡수하는 완충이자, 그만큼 늘어나는 재생 시작 지연입니다. 48 kHz/480 기준 프레임 4개 수준이라 체감되지 않습니다.
- **배치 `PLAYBACK_WRITE_BATCH_MS`(10 ms)** — 보호 PCM을 한 번에 보낼 목표 분량. Tauri invoke 비용은 페이로드 크기가 아니라 **호출 횟수**에 붙으므로 모아 보내 호출 빈도를 ~100 Hz로 고정합니다. `bufferSize` 16이면 초당 3,000회가 되어 메인 스레드가 잠기고 링이 말라 소리가 지지직거립니다(실측 확인). 기본값 480에서는 한 묶음이 정확히 한 프레임입니다.
- **리드 = 프리필 + 배치 한 묶음** — 배치에 물려 아직 나가지 않은 분량은 링에 없습니다. 리드가 모자라면 링이 프리필 선에 영영 닿지 못해 재생이 시작되지 않고 헬퍼가 `exit 4`로 끝납니다.
- **진행 중인 write는 항상 하나** — 그동안 도착한 프레임은 다음 묶음으로 합쳐집니다. 밀릴수록 묶음만 커지고 호출 횟수는 늘지 않으므로 밀린 만큼을 구조가 스스로 흡수합니다. 예전 프라미스 체인은 뒤처진 만큼이 그대로 지연·메모리로 누적됐습니다. 하나만 띄우는 구조가 순서도 보장합니다 — `writePcm`들보다 `control("end")`이 먼저 가면 마지막 프레임을 재생하기 전에 드레인이 시작돼 끝이 잘립니다.
- **시작 구간의 V/I는 0** — 아직 소리가 나가지 않았으니 소산 전력도 0입니다. 그래야 열 보호가 개입하지 않습니다. 변위 보호는 신호 자체로 결정되므로 프레임 0부터 정확합니다. 이후로는 가장 최근에 도착한 캡처 프레임으로 덮어씁니다.
- **헬퍼 종료 코드** — `0`은 재생 완료, `3`은 장치 연결 끊김(USB 분리 등), `4`는 프리필 대기 포기입니다. `4`는 보호 PCM이 제때 도착하지 않은 경우라 소리가 한 번도 나가지 않은 상태입니다. 사용자에게는 다시 시도하거나 Original로 바꾸라고 안내합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. `PlayerBar.tsx`(프레젠테이션 셸 분리)는 이미 추출돼 있고, 네이티브 브리지는 Electron이 아니라 Tauri(`window.audioCapture`/`audioPlayCapture`)로 전환을 마친 상태를 반영했습니다. (커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-11: 보호 스트리밍 재생을 반영했습니다. `capture/types.ts`에 `PlaybackMode`와 `PlaybackStreamPump`가 생겼습니다. `useNativeCapture`는 `stream: true` 모드에서 캡처 도착을 크레딧으로 삼는 자기 클로킹 생산 루프·배치 쓰기·`end` 순서 보장·`exit 4` 처리를 맡게 됐습니다. `useCaptureSession`은 `playbackMode` 의존성과 `streamPumpRef`를 얻어 엔진이 돌려준 보호 PCM을 재생 경로로 넘깁니다. `PlayerBar`는 Protected/Original 토글 배지(`playbackMode`/`onPlaybackModeChange`/`playbackModeLocked`)를, `DuplexFilePlayer`는 그 모드 상태와 세션 중 잠금을 담당합니다. §4의 소비처에서 삭제된 `channel/ChartDetailOverlay` 언급을 지우고 현재 소비처(`ProtectedComparePanel`·`useChannelWaveStreams`·`lib/render/raw-window.ts`)로 정정했습니다. 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: a465514..HEAD, 작업 트리 포함)
