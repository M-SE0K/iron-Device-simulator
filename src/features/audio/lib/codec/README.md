# codec

## 1. 도메인 설명

WAV 인코딩/디코딩과 재생용 파일 디코딩을 모아둔 도메인입니다. 변환 방향은 세 가지입니다. 캡처 세션의 원시 PCM을 표준 WAV로 저장하고 저장된 WAV는 다시 채널별 평면 배열로 읽어냅니다. 업로드된 오디오 파일은 재생용 인터리브 스테레오로 바꿉니다.

## 2. 프로젝트 전반에서의 역할

`player/`가 캡처 세션을 저장할 때, `channel/`이 보호 감쇠 비교 파형을 부분 디코딩할 때, `workspace/`가 저장된 세션의 채널 파형을 열어볼 때 이 도메인의 인코더/디코더를 씁니다. WAV 파싱은 RIFF 청크를 직접 읽는 방식(`wav-primitives.ts`)으로 짰습니다. 브라우저 `decodeAudioData`가 다채널·정수 PCM WAV를 안정적으로 다루지 못해서입니다. 그 파서가 실패하는 비-WAV 파일에 한해서만 `decodeAudioData`로 폴백합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `wav-primitives.ts` | RIFF 태그 읽기, 포맷/비트별 샘플 리더 생성 — 나머지 WAV 관련 파일이 공유하는 저수준 헬퍼 |
| `wav-encoder.ts` | 인터리브 PCM 프레임 배열 → 44바이트 헤더 WAV Blob(`pcmFramesToWavBlob`) |
| `wav-decoder.ts` | WAV Blob → 채널별 평면 `Float32Array`(`decodeAudioChannels`) — RIFF 직접 파싱 우선, 실패 시 `decodeAudioData` 폴백 |
| `wav-incremental.ts` | WAV 헤더만 먼저 읽고(`peekWavHeader`) 필요한 구간만 온디맨드로 디코딩(`decodeWavRange`) |
| `playback-decode.ts` | 업로드 파일 → 재생용 인터리브 스테레오 PCM(`decodeFileToStereo`) |

## 4. 의존성 및 흐름

- **가져오는 것**: `@/features/audio/lib/engine/core`의 `INT16_SCALE`/`CHANNELS`/`BYTES_PER_SAMPLE` — WAV 헤더의 채널 수·샘플 폭과 int16 정규화 스케일을 엔진과 같은 상수로 맞추려고 씁니다.
- **내부 의존**: `wav-decoder.ts`와 `wav-incremental.ts`는 둘 다 `wav-primitives.ts`의 `readTag`/`makeSampleReader`를 씁니다.
- **소비하는 도메인**:
  - `player/` — `useCaptureSession.ts`가 세션 종료 시 `wav-encoder.ts`로 저장용 WAV를 만듭니다.
  - `channel/` — `ProtectedComparePanel.tsx`가 `wav-incremental.ts`로 보호 감쇠 비교용 오디오를 구간별 백필합니다.
  - `workspace/` — `ChannelViewerOverlay.tsx`가 `wav-decoder.ts`로 저장된 세션의 오디오를 채널별로 디코딩합니다.
  - `DuplexFilePlayer.tsx`(`player/`) — `playback-decode.ts`로 업로드 파일을 재생용 인터리브 스테레오 PCM으로 바꿔 play-capture 헬퍼에 넘깁니다.

```
캡처 세션 원시 PCM → wav-encoder.ts:pcmFramesToWavBlob() → WAV Blob(저장)
저장된 WAV → wav-decoder.ts:decodeAudioChannels() → 채널별 Float32Array
저장된 WAV(부분) → wav-incremental.ts:peekWavHeader()+decodeWavRange() → 구간 Float32Array
업로드 파일 → playback-decode.ts:decodeFileToStereo() → 인터리브 스테레오 PCM(재생용)
```

## 5. 주요 인터페이스 / 진입점

- **`pcmFramesToWavBlob(frames: ArrayBuffer[], sampleRate: number, channels?: number): Blob`** — 인터리브 int16 PCM 프레임들을 44바이트 헤더 WAV로 감쌉니다. `channels` 생략 시 엔진 기본값(`CHANNELS`=2)을 씁니다.
- **`decodeAudioChannels(blob: Blob): Promise<DecodedChannels>`** — `{ channels: Float32Array[], sampleRate, durationSec }`. int16/int32/float32 WAV는 직접 파싱하고 WAV가 아니면 `decodeAudioData`로 폴백합니다.
- **`peekWavHeader(blob: Blob): Promise<WavHeader | null>`** — 전체를 디코딩하지 않고 헤더 44바이트만 읽어 채널 수·샘플레이트·전체 길이를 확인합니다.
- **`decodeWavRange(blob, header: WavHeader, channel: number, startSec: number, endSec: number): Promise<Float32Array>`** — 헤더 기준으로 필요한 바이트 구간만 슬라이스해 디코딩합니다. 지원하지 않는 `bitsPerSample`이면 예외를 던집니다.
- **`decodeFileToStereo(file: File, targetRate: number): Promise<DecodedPlayback>`** — `{ pcm, rate, duration }`. `OfflineAudioContext(2, ...)`로 지정한 샘플레이트에 맞춰 렌더링합니다. 모노 소스는 L=R로 업믹스한 뒤 `[L0,R0,L1,R1,...]` 인터리브로 반환합니다.
- **`readTag(view, offset)`** / **`makeSampleReader(view, bitsPerSample, format?)`** — RIFF 태그 4바이트 읽기, 포맷(1=PCM/3=float)·비트폭에 맞는 샘플 리더 함수를 만듭니다. 지원하지 않는 조합이면 `null`을 반환합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. `wav-primitives.ts` 공용 헬퍼 추출과 `playback-decode.ts`(구조적 재배치로 이 도메인에 들어온 재생용 디코더) 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
