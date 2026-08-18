# pcm-kit — 렌더 계층 벌크 PCM 커널

파형 엔벌로프(버킷별 min/max) 집계를 WebAssembly로 처리하는 작은 커널이다.
`ChannelWaveStore`(`src/features/audio/lib/render/wave-store.ts`)가 쓰던 "샘플마다
나눗셈+분기" JS 루프를 대체해, 채널 파형 백필·Protected 비교 시딩처럼 수천만 샘플을
도는 경로의 메인 스레드 점유 시간을 줄인다.

`ff_prot`(보호 엔진) WASM과는 **별개 모듈**이다. 엔진은 암호화·하드닝·벤더 드롭인
대상이지만, 이 커널은 표시용 유틸이라 평문으로 배포하고
(`scripts/build/wasm-encryption/`의 영향 없음) 엔진 교체와 수명도 다르다.

## 빌드

```bash
./build-pcm-kit.sh        # → public/wasm/pcm_kit.wasm (emcc, 없으면 Docker 폴백)
npm run build:wasm        # 엔진 빌드에 앞서 이 스크립트도 항상 함께 실행된다
```

산출물은 Emscripten 글루 JS가 없는 독립 `.wasm` 하나다(`--no-entry`, 약 1.5KB).
`-msimd128`로 내부 리덕션 루프를 LLVM 자동 벡터화한다 — WKWebView(macOS 13.3+)와
WebView2 모두 SIMD128을 지원하고, 미지원 환경에서는 instantiate가 실패해 로더가
JS 폴백으로 동작한다. **이 산출물이 없어도 앱은 깨지지 않고 느려질 뿐이다.**

## 계약

소비자는 `src/features/audio/lib/pcm-kit.ts`(로더 + 청크 분할 + JS 폴백) 하나뿐이고,
앱 코드는 `ChannelWaveStore.addSamples()`를 통해서만 간접적으로 쓴다.

1. 호출자가 `pcmkit_in()` 스크래치(1 MiB)에 인터리브 원시 샘플을 복사한다
   (format 0 = int16, 1 = float32).
2. `pcmkit_envelope(format, frames, channels, channel, startSec, rate, bucketSec,
   maxBuckets)` — 반환값은 기록된 버킷 수(음수 = 오류). 채널 추출과 버킷별
   min/max, 블록 peak/제곱합(sumsq)을 한 번에 계산한다.
3. `pcmkit_min()/pcmkit_max()[0..n)`이 버킷 `(first + j)`의 정규화(-1..1) min/max.
   `first`는 `pcmkit_stats()[2]`. 빈 버킷은 min=+inf > max=-inf 센티널.
4. 버킷 상태(seen/compact/스냅숏)는 계속 JS(`ChannelWaveStore`)가 소유한다 —
   커널은 호출당 무상태라 스트림 도중 JS↔WASM 전환이 안전하다.

버킷 경계 산식(샘플 소속 = `floor((startSec + i/rate)/bucketSec)`을 버킷당 경계
인덱스 1회 계산으로 재구성)은 `pcm_kit.c`와 `pcm-kit.ts`의 JS 폴백이 **반드시 동일**
해야 한다 — 한쪽을 고치면 다른 쪽도 함께 고칠 것. 옛 per-sample floor 산식과는
부동소수점 타이 경계에서 ±1샘플 배정 차이가 날 수 있으나 표시 전용이라 무해하다.

## 성능

node(V8) 기준, 4M 프레임 × 8ch 인터리브 int16에서 1채널 집계:
기존 JS 경로(채널 추출 + per-sample 버킷팅) 98M samples/s → 커널 472M samples/s
(**약 4.8×**, 입력 힙 복사 포함). 채널 수가 적을수록 추출 스트라이드가 짧아져 더
빨라진다. 앱에서는 `NEXT_PUBLIC_IRON_PERF=1` 빌드의 `envelope_seed`(Protected 비교
입력 시딩)·`envelope_backfill`(채널 파형 백필) 스테이지로 실측할 수 있다.

전/후 비교는 같은 측정 빌드 안에서 콘솔로 경로를 바꿔가며 한다 —
`__ironPerf.envelopeMode("legacy" | "js" | "wasm")` (localStorage 영속):
`legacy`는 pcm-kit 도입 전 per-sample 구현(wave-store.ts에 보존), `js`는 신 JS 폴백
강제, `wasm`이 기본. 모드를 바꾼 뒤 파일 재업로드/뷰 토글로 시나리오를 다시
트리거하면 `envelope_*_legacy`/`_js` 스테이지로 나란히 기록되어 한 스냅숏에서
비교된다.
