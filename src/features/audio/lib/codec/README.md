# codec

## 1. 도메인 설명

WAV 인코딩과 온디맨드 디코딩, 재생용 파일 디코딩을 모아둔 도메인입니다. 변환 방향은 세 가지입니다. 캡처 세션의 원시 PCM을 표준 WAV로 저장합니다. 저장된 WAV는 헤더만 먼저 읽고 필요한 구간·채널만 온디맨드로 디코딩합니다. 업로드된 오디오 파일은 재생용 인터리브 스테레오로 바꿉니다.

## 2. 프로젝트 전반에서의 역할

`player/`가 캡처 세션을 저장할 때(`wav-encoder.ts`), `channel/`이 보호 감쇠 비교 파형을 구간별로 백필할 때(`wav-incremental.ts`), `player/`가 업로드 파일을 재생용으로 바꿀 때(`playback-decode.ts`) 이 도메인을 씁니다. WAV 파싱은 RIFF 헤더를 직접 읽는 방식(`wav-primitives.ts`)으로 짰습니다. 브라우저 `decodeAudioData`가 다채널·정수 PCM WAV를 안정적으로 다루지 못해서입니다. 전체 디코딩과 비-WAV `decodeAudioData` 폴백은 `wav-decoder.ts`(`decodeAudioChannels`)가 맡았습니다. 이 파일은 유일한 소비처였던 `workspace/ChannelViewerOverlay.tsx`와 같은 커밋 범위에서 삭제됐습니다. 지금 남은 디코딩 경로는 온디맨드 구간 디코딩과 재생용 디코딩 둘뿐입니다. `decodeAudioData` 폴백은 `playback-decode.ts`가 내부에서 쓰는 `OfflineAudioContext` 경로 외에는 없습니다. `playback-decode.ts`의 `DecodedPlayback` 타입은 `channel/`·`dashboard/`·`player/capture`가 type-only import로도 널리 참조합니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `wav-primitives.ts` | RIFF 태그 읽기, 포맷/비트별 샘플 리더 생성 — 나머지 WAV 관련 파일이 공유하는 저수준 헬퍼 |
| `wav-encoder.ts` | 인터리브 PCM 청크 배열(`ArrayBuffer`/`Uint8Array` 뷰) → 44바이트 헤더 WAV Blob(`pcmFramesToWavBlob`) |
| `wav-incremental.ts` | WAV 헤더만 먼저 읽고(`peekWavHeader`) 필요한 구간만 온디맨드로 디코딩(`decodeWavRange`) |
| `playback-decode.ts` | 업로드 파일 → 재생용 인터리브 스테레오 PCM(`decodeFileToStereo`)과 그 결과 타입 `DecodedPlayback` |

## 4. 의존성 및 흐름

- **가져오는 것**: `@/features/audio/lib/engine/core`의 `INT16_SCALE`(`wav-primitives.ts` — int16 정규화)과 `CHANNELS`/`BYTES_PER_SAMPLE`(`wav-encoder.ts` — WAV 헤더의 채널 수·샘플 폭)을 엔진과 같은 상수로 맞추려고 씁니다.
- **내부 의존**: `wav-incremental.ts`가 `wav-primitives.ts`의 `readTag`/`makeSampleReader`를 씁니다.
- **소비하는 도메인**:
  - `player/` — `capture/useCaptureSession.ts`가 세션 저장 시 `PcmFrameStore.byteChunks()` 산출을 `wav-encoder.ts`에 그대로 넘겨 WAV를 만듭니다. `DuplexFilePlayer.tsx`는 `playback-decode.ts`로 업로드 파일을 재생용 인터리브 스테레오 PCM으로 바꿔 play-capture 헬퍼에 넘깁니다.
  - `channel/` — `hooks/useProtectedCompareStreams.ts`가 `wav-incremental.ts`로 보호 감쇠 비교용 오디오를 구간별 백필합니다.
  - 타입만 쓰는 곳 — `channel/ProtectedComparePanel.tsx`·`dashboard/DashboardViewGrid.tsx`·`player/capture/types.ts`가 `DecodedPlayback`을 type-only import합니다.

```
캡처 세션 원시 PCM(PcmFrameStore.byteChunks()) → wav-encoder.ts:pcmFramesToWavBlob() → WAV Blob(저장)
저장된 WAV(부분) → wav-incremental.ts:peekWavHeader()+decodeWavRange() → 구간 Float32Array
업로드 파일 → playback-decode.ts:decodeFileToStereo() → 인터리브 스테레오 PCM(재생용)
```

## 5. 주요 인터페이스 / 진입점

- **`pcmFramesToWavBlob(frames: readonly (ArrayBuffer | Uint8Array<ArrayBuffer>)[], sampleRate: number, channels?: number): Blob`** — 인터리브 int16 PCM 청크들을 44바이트 헤더 WAV로 감쌉니다. `channels` 생략 시 엔진 기본값(`CHANNELS`=2)을 씁니다. `Uint8Array` 뷰를 복사 없이 받아 `PcmFrameStore.byteChunks()` 산출을 그대로 넘길 수 있습니다.
- **`peekWavHeader(blob: Blob): Promise<WavHeader | null>`** — 전체를 디코딩하지 않고 헤더 44바이트만 읽어 채널 수·샘플레이트·데이터 크기·재생 길이를 확인합니다.
- **`decodeWavRange(blob, header: WavHeader, channel: number, startSec: number, endSec: number): Promise<Float32Array>`** — 헤더 기준으로 필요한 바이트 구간만 슬라이스해 디코딩합니다. 지원하지 않는 `bitsPerSample`이면 예외를 던집니다.
- **`decodeFileToStereo(file: File, targetRate: number): Promise<DecodedPlayback>`** — `{ pcm, rate, duration }`. `OfflineAudioContext(2, ...)`로 지정한 샘플레이트에 맞춰 렌더링합니다. 모노 소스는 L=R로 업믹스한 뒤 `[L0,R0,L1,R1,...]` 인터리브로 반환합니다.
- **`readTag(view, offset)`** / **`makeSampleReader(view, bitsPerSample, format?)`** — RIFF 태그 4바이트 읽기, 포맷(1=PCM/3=float)·비트폭에 맞는 샘플 리더 함수를 만듭니다. 지원하지 않는 조합이면 `null`을 반환합니다.

## 6. 변경 이력(요약)

- 2026-07-30: 도메인 README 최초 작성 — 현재 코드 기준. `wav-primitives.ts` 공용 헬퍼 추출과 `playback-decode.ts`(구조적 재배치로 이 도메인에 들어온 재생용 디코더) 반영(커밋 범위: 0188d33..312f5bb, 작업 트리의 커밋되지 않은 변경 포함)
- 2026-08-19: `wav-decoder.ts`(`decodeAudioChannels`) 삭제 반영 — 유일 소비처 `workspace/ChannelViewerOverlay.tsx`와 함께 사라졌고, 남은 디코딩 경로는 `wav-incremental.ts`·`playback-decode.ts` 둘이다. `pcmFramesToWavBlob`의 `frames` 인자를 `readonly (ArrayBuffer | Uint8Array<ArrayBuffer>)[]`로 확장(`PcmFrameStore.byteChunks()` 무복사 전달용). 소비처 목록을 현행화(`channel/hooks/useProtectedCompareStreams.ts`, `DecodedPlayback` type-only 참조 3곳). 섹션 1·2·3·4·5 부분 갱신 (커밋 범위: 4d86f32..24d1daa)
