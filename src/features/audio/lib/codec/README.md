# codec

## 1. 도메인 설명

캡처한 int16 PCM 버퍼를 저장용 WAV로 굽고, 저장된 WAV를 다시 채널별 파형으로 되읽는 코덱 계층이다. 이 폴더만 보면 "세션 원본 PCM ↔ WAV Blob" 왕복 변환과, 과거 구간만 잘라 읽는 온디맨드 슬라이스 디코딩이 어디서 어떻게 처리되는지 알 수 있다.

이 계층이 따로 필요한 건 브라우저 기본 `decodeAudioData`가 정수 PCM이나 다채널 WAV를 안정적으로 지원하지 않아서다. V/I 센스 채널은 int16으로 캡처하는데(ch0=V/ch1=I, 그 밖의 확장 채널까지), 이 값을 그대로 왕복하려면 RIFF 청크를 직접 쓰고 직접 파싱하는 수밖에 없다. 네 파일이 그 저수준 처리를 나눠 맡는다 — 인코더 1개, 디코더 2개(완전 디코딩·온디맨드 슬라이스), 그리고 둘이 공유하는 원시 리더 1개.

## 2. 프로젝트 전반에서의 역할

캡처 세션과 그 결과를 보여주는 화면들 사이의 직렬화 접점이다. `useCaptureSession`이 모은 세션 raw 버퍼를 WAV Blob으로 만들어 Workspace가 저장하게 하고, 저장된 Blob을 `ChannelViewerOverlay`(전체 채널 정적 뷰)와 `ChartDetailOverlay`(라이브/과거 채널 뷰)가 다시 파형으로 펼친다.

- **인코딩(나가는 방향)**: `player/capture/useCaptureSession`이 세션 종료 시 raw N채널 int16 프레임 배열을 `pcmFramesToWavBlob()`으로 굽는다. Workspace 저장은 원본 업로드 파일이 아니라 이 WAV(실제 분석에 쓰인 신호)를 항목의 오디오로 넣는다.
- **완전 디코딩(들어오는 방향)**: `workspace/ChannelViewerOverlay`가 저장된 항목을 열 때 `decodeAudioChannels()`로 전체를 한 번에 채널별 Float32로 편다.
- **온디맨드 디코딩(들어오는 방향)**: `chart/ChartDetailOverlay`의 채널 뷰가 `peekWavHeader()`/`decodeWavRange()`/`appendWindowed()`로 헤더만 엿보거나, 확대한 과거 구간만 잘라 읽거나, 라이브 윈도우를 이어붙인다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `wav-encoder.ts` | 인터리브 int16 PCM 프레임 배열을 44바이트 표준 헤더 WAV Blob으로 인코딩하는 `pcmFramesToWavBlob()`. 채널 수 기본값은 엔진 와이어 ABI인 2ch(V/I)이지만, 마이크 전 채널 저장 시에는 N채널 그대로 넘긴다. 샘플 폭은 `engine/core`의 `BYTES_PER_SAMPLE`(2바이트=int16) 고정 |
| `wav-decoder.ts` | Blob을 채널별 평면 Float32(`DecodedChannels`)로 펴는 `decodeAudioChannels()`. 내부 `parseWav()`가 RIFF/WAVE 청크를 직접 순회해 fmt·data를 찾고, 지원 포맷(PCM int16/int32, IEEE float32)이면 직접 변환한다. WAV가 아니거나 파싱에 실패하면(원본 mp3 저장 등) `AudioContext.decodeAudioData`로 폴백 |
| `wav-incremental.ts` | `pcmFramesToWavBlob`이 만든 "고정 44바이트 헤더 단일 data 청크" WAV만 다루는 온디맨드 슬라이서. 헤더 44바이트만 읽는 `peekWavHeader()`, `[startSec, endSec)` 구간만 잘라 디코딩하는 `decodeWavRange()`, 윈도우 뒤에 새 샘플을 이어붙이고 상한을 넘으면 앞을 자르는 `appendWindowed()` |
| `wav-primitives.ts` | 완전 디코더와 온디맨드 슬라이서가 공유하는 저수준 리더. 4바이트 청크 태그를 읽는 `readTag()`, bit 폭·포맷별로 샘플을 [-1, 1) Float32로 읽는 리더를 만드는 `makeSampleReader()`(PCM int16/int32, IEEE float32 지원, 그 외 null) |

## 4. 의존성 및 흐름

**이 도메인이 import하는 것 (들어오는 의존)**

- `engine/core` → `CHANNELS`(2), `BYTES_PER_SAMPLE`(2) (`wav-encoder.ts`가 기본 채널 수와 샘플 폭으로 사용)
- 내부: `wav-decoder.ts`·`wav-incremental.ts` → `wav-primitives.ts`(`readTag`/`makeSampleReader`)

**이 도메인을 import하는 곳 (나가는 의존)**

- `components/player/capture/useCaptureSession.ts` → `pcmFramesToWavBlob` (세션 raw 버퍼 → WAV Blob 인코딩)
- `components/workspace/ChannelViewerOverlay.tsx` → `decodeAudioChannels`, `DecodedChannels` (저장 항목 전체 채널 정적 파형)
- `components/chart/ChartDetailOverlay.tsx` → `peekWavHeader`, `decodeWavRange`, `appendWindowed` (채널 뷰 헤더 확인·과거 구간 온디맨드 조회·라이브 윈도우 누적)

**내부 처리 흐름 (캡처 → 저장 → 재열람)**

```
캡처 세션 raw N채널 int16 프레임[]
  → pcmFramesToWavBlob(frames, sampleRate, channels)   # RIFF 헤더 44B + data
  → WAV Blob  ── Workspace 저장 / 세션 핸들 보관
       ├─ decodeAudioChannels(blob)      # 전체 → 채널별 Float32 (ChannelViewerOverlay)
       └─ peekWavHeader(blob)            # 44B만 → 채널 수/SR/길이 (ChartDetailOverlay)
            → decodeWavRange(blob, header, ch, startSec, endSec)  # 요청 구간만
            → appendWindowed(existing, incoming, maxSamples)      # 라이브 윈도우 누적
```

완전 디코더(`wav-decoder`)와 온디맨드 슬라이서(`wav-incremental`)를 가른 기준은 "입력 전제"다. 앞쪽은 임의의 WAV/포맷을 받아야 하니 청크를 처음부터 순회하는 범용 파서로 두었고, 뒤쪽은 언제나 `pcmFramesToWavBlob`이 만든 고정 헤더 Blob 하나만 다룬다는 전제 위에서 헤더를 44바이트만 엿보고 요청 구간만 잘라 읽는다. 덕분에 온디맨드 조회 비용은 전체 세션 길이가 아니라 요청한 구간 길이에만 비례한다.

## 5. 주요 인터페이스 / 진입점

- `pcmFramesToWavBlob(frames: ArrayBuffer[], sampleRate: number, channels?: number): Blob` — 인터리브 int16 PCM 프레임 배열 → WAV Blob. `channels` 생략 시 `CHANNELS`(2). 샘플 폭은 int16(2바이트) 고정.
- `decodeAudioChannels(blob: Blob): Promise<DecodedChannels>` — Blob → 채널별 평면 Float32(`[-1, 1]` 정규화), 샘플레이트, 길이(초). RIFF 직접 파싱 우선, 실패 시 `decodeAudioData` 폴백. 채널 인덱스가 곧 채널 번호(ch0=V, ch1=I, ch2..=확장).
- `DecodedChannels` (type) — `{ channels: Float32Array[]; sampleRate: number; durationSec: number }`.
- `peekWavHeader(blob: Blob): Promise<WavHeader | null>` — 앞 44바이트만 읽어 채널 수/샘플레이트/bit 폭/data 크기/길이를 얻는다. RIFF/WAVE/data 시그니처가 아니면 null. 전체 샘플을 훑지 않아 사실상 무료.
- `WavHeader` (type) — `{ channels; sampleRate; bitsPerSample; dataOffset(항상 44); dataSize; durationSec }`.
- `decodeWavRange(blob, header, channel, startSec, endSec): Promise<Float32Array>` — 한 채널의 `[startSec, endSec)` 구간만 슬라이스 디코딩. 비용이 구간 길이에만 비례한다. 지원하지 않는 bit 폭이면 throw.
- `appendWindowed(existing: Float32Array, incoming: Float32Array, maxSamples: number): Float32Array` — 기존 윈도우 뒤에 새 샘플을 이어붙이고, 총 길이가 `maxSamples`를 넘으면 앞을 잘라 상한을 지킨다.
- `readTag(view: DataView, offset: number): string` — 4바이트 청크 태그를 문자열로.
- `makeSampleReader(view: DataView, bitsPerSample: number, format?: number): ((byteOffset: number) => number) | null` — 포맷·bit 폭에 맞는 샘플 리더. PCM(format 1) int16/int32, IEEE float(format 3) float32 지원, 그 외 null. `format` 생략 시 1(PCM).

## 6. 변경 이력(요약)
- 2026-07-13: 최초 작성 — 기존 `lib/wav-encoder.ts`/`lib/wav-decoder.ts`가 `lib/codec/`로 이동·분할되면서 신규 도메인화(온디맨드 슬라이서 `wav-incremental.ts`, 공용 저수준 리더 `wav-primitives.ts` 추가). (기준 커밋: HEAD, 커밋되지 않은 워크트리 변경 반영)
- 2026-07-14: 캡처·저장 PCM 샘플 폭을 int32에서 int16으로 통일한 것을 반영 — `BYTES_PER_SAMPLE` 4→2, 인코딩 대상 프레임과 `pcmFramesToWavBlob` 출력이 int16(2바이트)으로 바뀌었다. 인코더가 굽는 WAV는 이제 16-bit이고, `wav-decoder`/`wav-primitives`의 `makeSampleReader`는 헤더의 `bitsPerSample`을 따르므로 int16/int32/float32를 그대로 지원한다(기존 32-bit 저장물도 계속 읽힘). 섹션 1·2·3·4·5 부분 갱신 (커밋되지 않은 워크트리 변경 반영)
