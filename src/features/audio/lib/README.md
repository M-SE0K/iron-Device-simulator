# lib

## 1. 도메인 설명

실시간 세션이 다루는 대용량 PCM·프레임 데이터를 GC 부담 없이 쌓고(슬랩·청크 배열) 파형 엔벌로프 집계를 WASM 커널로 가속하는 루트 유틸 모음입니다. 이 README는 `lib/` 바로 아래의 낱개 파일 5개만 다룹니다 — 하위 폴더(`cache/`·`codec/`·`engine/`·`export/`·`render/`)는 각자 README가 있습니다.

루트에 남아 있는 기준은 "특정 하위 도메인 하나에 속하지 않고 여러 도메인이 공유하는 것"입니다. PCM 프레임 보관(`pcm-frame-store.ts`)은 player가 쓰고 그 산출을 codec이 받습니다. 엔벌로프 커널(`pcm-kit.ts`)은 render가 씁니다. 프레임 로그(`frame-log.ts`)·로컬 폴더 읽기(`local-folder.ts`)·mm 단위 표기(`units.ts`)는 dashboard·workspace·chart가 나눠 씁니다.

## 2. 프로젝트 전반에서의 역할

- `pcm-kit.ts`는 `native/pcm-kit/pcm_kit.c`를 컴파일한 `public/wasm/pcm_kit.wasm`(글루 JS 없는 독립 모듈)의 로더 겸 폴백입니다. `render/wave-store.ts`(`ChannelWaveStore.addSamples`)가 유일한 임포터로, 파형 min/max 버킷 집계의 벌크 커널로 씁니다. 산출물이 없거나 로드에 실패해도 앱은 같은 산식의 JS 폴백으로 계속 동작합니다 — 깨지지 않고 느려질 뿐입니다.
- `pcm-frame-store.ts`는 캡처 세션의 int16 인터리브 PCM을 프레임 단위로 쌓는 저장 구조입니다. `player/capture/useNativeCapture.ts`(원시 N채널 캡처, `rawCaptureRef`)와 `player/capture/useCaptureSession.ts`(보호 출력, `protectedCaptureRef`)가 각각 인스턴스를 만듭니다.
- `frame-log.ts`는 분석 프레임(time/temperature/excursion)의 세션 누적 로그입니다. `dashboard/DashboardClient.tsx`가 인스턴스를 만들고 `dashboard/hooks/useWorkspaceSave.ts`가 저장 시 배열로 꺼냅니다.
- `local-folder.ts`는 `window.localFolder`(Tauri IPC) 브리지의 얇은 헬퍼로, `workspace/`의 로컬 폴더 목록에서 항목을 실제 `File`로 읽어줍니다.
- `units.ts`는 excursion 원시값의 mm 환산·표기를 `chart/ExcursionChart.tsx`와 `workspace/RecordsDrawer.tsx`가 같은 산식으로 쓰게 하는 단일 소스입니다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `pcm-kit.ts` | 파형 엔벌로프(min/max 버킷) 집계 벌크 커널 — `pcm_kit.wasm` 지연 로드 + 동일 산식 JS 폴백(`aggregateEnvelope`) |
| `pcm-frame-store.ts` | int16 인터리브 PCM을 슬랩 단위로 쌓는 프레임 저장 구조(`PcmFrameStore`) — WAV 저장용 `byteChunks()` 포함 |
| `frame-log.ts` | 분석 프레임(time/temperature/excursion)을 65,536프레임 단위 `Float64Array` 청크로 누적하는 `FrameLog` |
| `local-folder.ts` | 로컬 폴더 항목을 `window.localFolder.readFile()`로 읽어 `File`로 만드는 `readLocalAudioFile()` |
| `units.ts` | excursion 원시값 → mm 환산(`toMm`, ×1/1000)과 소수 3자리 표기(`formatMm`) |

하위 폴더는 각자 README가 있습니다: `cache/`(브라우저 저장소 캐시), `codec/`(WAV 인코딩/디코딩), `engine/`(WASM 분석 엔진), `export/`(내보내기), `render/`(차트 렌더 파이프라인).

## 4. 의존성 및 흐름

- **가져오는 것**: `engine/core`의 `BYTES_PER_SAMPLE`(`pcm-frame-store.ts` — 프레임 바이트 계산), `@/shared/lib/iron-perf`의 `getEnvelopeMode`(`pcm-kit.ts` — A/B 측정 토글), `@/shared/types/native-bridge`의 `LocalAudioFileEntry`(`local-folder.ts`), `features/audio/types`의 `AnalysisFrame`(`frame-log.ts`).
- **바깥으로 나가는 요청**: `pcm-kit.ts`가 첫 호출 때 `${NEXT_PUBLIC_WASM_DIR || "/wasm"}/pcm_kit.wasm`을 `fetch`합니다(1회, 실패 시 재시도 없이 JS 폴백 확정).

```
player/capture(useNativeCapture·useCaptureSession)
    → PcmFrameStore.append()로 세션 PCM 축적
    → byteChunks() → codec/wav-encoder.pcmFramesToWavBlob() → 저장용 WAV Blob
render/wave-store.ChannelWaveStore.addSamples()
    → pcm-kit.aggregateEnvelope() → (pcm_kit.wasm 커널 | JS 폴백) → 버킷 min/max emit
dashboard/DashboardClient → FrameLog.push() ── 저장 시 toFrames() → useWorkspaceSave
workspace/WorkspaceContext·useLocalFolderConnection → readLocalAudioFile() → window.localFolder(Tauri IPC)
chart/ExcursionChart·workspace/RecordsDrawer → formatMm()
```

## 5. 주요 인터페이스 / 진입점

- `aggregateEnvelope(src, channels, channel, frames, startSec, sampleRate, bucketSec, maxBuckets, emit): EnvelopeStats` — 인터리브 PCM(`Int16Array | Float32Array`)에서 한 채널의 버킷별 min/max 엔벌로프와 블록 stats(`{peak, sumSq}`)를 집계합니다. 결과는 `emit(firstBucket, count, mins, maxs)` 콜백으로 버킷 구간 단위 전달 — `mins`/`maxs`는 다음 청크 처리 전까지만 유효한 뷰라 콜백 안에서 즉시 병합해야 합니다. WASM 로드 전·실패·미지원 환경에서는 같은 분해의 JS 폴백으로 동작합니다(버킷 결과는 두 경로가 동일, `sumSq`만 누적 정밀도 미세 차이). 호출당 무상태라 스트림 중간의 JS→WASM 전환도 안전합니다. `getEnvelopeMode() === "js"`(iron-perf A/B 측정 토글)면 커널이 로드돼 있어도 JS 경로를 강제합니다.
- `envelopeChunkFrames(channels, isI16, bucketSec, sampleRate): number` — 호출당 프레임 상한(입력 스크래치 1 MiB·출력 8,192버킷 계약을 둘 다 만족). WASM/JS가 같은 분해를 쓰도록 공통 계층에서 계산합니다. 동등성 테스트가 분해 재현에 씁니다. C 쪽 용량 상수를 바꾸면 이 파일의 `IN_CAP_BYTES`/`OUT_CAP`도 함께 바꿔야 합니다 — 로드 시 검증해 불일치면 커널을 쓰지 않습니다.
- `new PcmFrameStore({ channels, sampleRate, samplesPerFrame, expectedFrames? })` — 프레임 저장 구조. 첫 슬랩은 `expectedFrames` 크기(최대 256 MiB), 이후 슬랩은 16 MiB 단위로 자랍니다. `append(src): Int16Array`(쓴 프레임 뷰 반환), `appendSilence(n)`, `frame(i)`, `frameRun(i, maxFrames)`(같은 슬랩 안 연속 프레임을 한 뷰로 — 벌크 소비자용), `byteChunks(): Uint8Array<ArrayBuffer>[]`(WAV 인코딩에 무복사 전달), `frameCount`/`totalSamples`.
- `new FrameLog()` — `push(frame: AnalysisFrame)` / `toFrames(): AnalysisFrame[]` / `clear()` / `length`. 내부는 65,536프레임 단위 `Float64Array` 3열(time/temperature/excursion) 청크입니다.
- `readLocalAudioFile(entry: LocalAudioFileEntry): Promise<File>` — `window.localFolder.readFile(entry.path)`로 읽어 `File`(mime·mtime 보존)을 만듭니다. 브리지가 없거나 읽기 실패면 throw합니다 — Tauri 밖(일반 브라우저)에서는 항상 throw.
- `toMm(v): number` / `formatMm(raw): string` — 원시값을 ×1/1000으로 mm 환산하고 소수 3자리(`MM_DECIMALS`=3)로 표기합니다. `formatMm`은 null/undefined/비유한값에 `"—"`를 돌려줍니다.

## 6. 변경 이력(요약)

- 2026-08-19: 최초 작성 (mse0k-domain-tw)
