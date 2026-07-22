# electron/native/wasm-engine/ — ff_prot 참조 구현 (검증용 `libirontune.so` 스텁)

> 이 폴더는 `electron/` 밑에 있지만 Electron 전용이 아닙니다 — 컴파일 산출물
> (`public/wasm/ff_prot.{js,wasm}`)은 순수 웹 빌드(`build:desktop`)에도 그대로 쓰입니다.

> ⚠️ **정품 아님.** Iron Device 정품 `libirontune.so` 의 원본 소스를 아직 받지 못해
> 임의로 구성한 **물리 근사 모델**입니다. 실제로는 이 `.c` 소스를 Emscripten으로
> 브라우저 타깃 WASM(`public/wasm/ff_prot.{js,wasm}`, `build-wasm.sh`)으로 컴파일해
> `src/features/audio/lib/engine/adapters/wasm-client.ts`가 브라우저 안에서 직접
> 호출한다 — `.so`/koffi FFI 로딩 경로는 쓰이지 않는다. 정품 소스를 받으면 이
> 디렉터리는 폐기합니다.

## 함수 시그니처 (adapters/wasm-client.ts 와 1:1)

| 함수 | 시그니처 |
|---|---|
| `ff_prot_init` | `int (void)` |
| `ff_prot_set_param` | `int (void)` — 현재 사실상 NOP |
| `ff_prot_start_exec` | `int (void* buf, uint32 samples_per_ch, uint32 bytes_per_sample, uint32 channels, int32 amb_temp, void* spk_temp, void* spk_exc, const void* v_sensing, const void* i_sensing)` — 9-인자. **`buf`는 In/Out** — 보호 감쇠 결과를 같은 버퍼에 되쓴다. `v_sensing`/`i_sensing`은 2026-07-21 새로 확인된 벤더 소스 기준 인자로, 실제 캡쳐된 V/I sensing 데이터를 받는다 — 둘 다 `int16[samples_per_ch]` **단일(모노) 스트림**(channels별 배열 아님). 네이티브 캡처 장치가 4ch 이상이면 ch2(V)/ch3(I)를 실제로 채워 넘기고, 그 미만이면(getUserMedia 폴백 포함) NULL(자세한 내용은 `ff_prot.h` 상단 주석) |
| `ff_prot_stop_exec` | `int (void)` |

- **입력 버퍼**: `engine/utils.ts` 의 `deinterleave()` 결과인 **planar** int16 PCM (`[ch0 전체][ch1 전체]`, `bytes_per_sample=2`), 2ch, `amb_temp=25`. `samples_per_ch`는 고정값이 아니라 Calibration UI(bufferSize)에서 세션마다 넘어오는 런타임 값이다(기본 480 samples/ch = 10 ms/frame @ 48 kHz).
  ⚠️ 실제 벤더 시그니처엔 `sample_rate_hz` 인자가 없다(검증됨) — `dt = samples_per_ch / sample_rate_hz`로 열 적분 스텝을 계산하려면 시간 정보가 필요한데, 실제 라이브러리가 이를 어디서 얻는지는 미확인이다(`VENDOR-API-SPEC.md` 4장 벤더 확인 요청 항목 #1). 이 스텁은 잠정적으로 `ff_prot.c`의 `DEFAULT_SAMPLE_RATE_HZ`(고정 48 kHz)로 근사한다 — Calibration UI에서 세션 sampleRate를 바꿔도 이 스텁의 dt/LPF 계수엔 더 이상 반영되지 않는다(알려진 한계).
- **출력**: `spk_temp[ch]` = 보이스코일 온도 `[°C]`, `spk_exc[ch]` = 콘 피크 변위 `[µm]`, int32, ch0=V / ch1=I.
- **출력(PCM)**: `buf`에 **보호 감쇠가 적용된 planar PCM**이 in-place로 되쓰인다. 벤더 래퍼(`audio_ff_prot_processing`)가 exec 직후 이 버퍼를 다시 읽어 인터리브로 복원하는 것과 같은 규약이다. 호출자가 원본을 계속 써야 하면 넘기기 전에 복사해 둬야 한다.

## 모델 요약

블록마다 채널 독립으로 **3-pass**를 돈다:

- **pass A — 입력 스캔**: 블록 RMS + LF 강조 1-pole 저역통과 피크 → "감쇠 안 하면 어떻게 되는가" 예측
- **pass B — 감쇠 적용**: 예측이 한계를 넘으면 게인을 깎아 `buf`에 in-place로 되쓴다
- **pass C — 출력 재스캔**: 감쇠된 신호로 온도/변위를 다시 추정 → 이 값이 차트로 나간다

물리 근사는 다음과 같다:

1. 블록 RMS → 전기 소산 전력 `P ∝ rms²` (`v_sensing`/`i_sensing`이 둘 다 주어지면 pass C의
   전력만 실측 `P = mean(v·i)`로 대체 — 네이티브 캡처 장치가 4ch 이상이면 ch2(V)/ch3(I)를
   실측치로 넘긴다, `wasm-client.ts`/`reframeNativeChunk.ts` 참고. getUserMedia 폴백이나
   2ch 미만 장치는 여전히 NULL이라 rms² 근사만 쓰인다)
2. 1차 열 RC 적분 `T ← T + (dt/τ)(amb + Rth·P − T)` → 온도가 천천히 상승 (상태 누적)
3. LF 강조 1-pole 저역통과의 블록 피크 → 변위(µm). 저주파일수록 크고 고주파일수록 작음.

감쇠 게인은 두 한계 중 더 빡빡한 쪽을 따른다:

- **변위**: 진폭에 선형이라 `EXC_LIMIT_UM / 예측변위`가 그대로 게인
- **온도**: 적분기라 즉시 못 내리므로, 평형 온도가 `TEMP_LIMIT_C`에 걸리는 전력으로 제한한다 — `P ∝ g²·rms²`이므로 게인은 전력비의 제곱근

프레임 경계에서 게인이 계단처럼 튀면 지직거리므로(zipper noise) 직전 게인에서 새 게인까지 샘플 단위로 선형 보간하고, 줄일 땐 빠르게(`GAIN_ATTACK`) 되돌릴 땐 천천히(`GAIN_RELEASE`) 스무딩한다.

튜닝 상수(`NOMINAL_POWER_W`, `THERMAL_RES_C_W`, `THERMAL_TAU_S`, `EXC_LPF_FC_HZ`, `EXC_FULLSCALE_UM`, `EXC_LIMIT_UM`, `TEMP_LIMIT_C`, `GAIN_MIN`, `GAIN_ATTACK`, `GAIN_RELEASE`)는 `ff_prot.c` 상단에 모여 있습니다.

> ⚠️ **감쇠 커브는 보호 성능의 근거가 아닙니다.** 한계값도 게인 커브도 이 스텁이 지어낸
> 임의값입니다 — 벤더 ABI의 `ff_prot_set_param()`이 무인자 NOP이라 스피커별 파라미터를
> 주입할 경로 자체가 없어서 `#define`으로 고정했습니다. 파이프라인(캡처→감쇠→반환→
> 파형비교/WAV)이 도는지 검증하는 용도이며, UI에도 "스텁 감쇠 — 실제 보호 성능 아님"
> 배지가 붙습니다. 정품 `.so` 수령 시 통째로 폐기합니다.

## 순수 C 셀프테스트 (물리 모델 검증용, 앱과 무관)

```bash
# Linux x86-64 전용
cd electron/native/wasm-engine
make selftest        # 순수 C 셀프테스트(온도 상승 + ch0(V)/ch1(I) 변위 차이) 확인
```

`make`(→ `libirontune.so`)는 참고용으로 남아 있지만 앱은 이 `.so`를 로드하지 않는다 —
실제로 시뮬레이터에 물리는 방법은 리포 루트에서 `npm run wasm:build` (요구: `emcc`) 다음
`npm run dev`.

## ⚠️ 단위 주의 (engine/utils.ts 후처리와의 관계)

`engine/utils.ts` 의 `applyPostCorrection()` 은 raw 출력에 `profile.tempMult · powerTempMult()` (온도) / `profile.excMult` (변위)만 곱해 **그대로** 화면 값으로 씁니다.

- **온도**: 이 참조 구현은 `°C` 정수를 출력하므로 `tempMult≈1` 에서 그대로 `°C` 로 표시됩니다. (OK)
- **변위**: 이 참조 구현은 `µm` 를 출력합니다. mock 모델의 `mm` 축과 맞추려면
  - TS 쪽에서 `rawExc/1000` 하거나,
  - `SPEAKER_PROFILES[...].excMult` 를 0.001 스케일로 두거나,
  - 이 파일의 `EXC_FULLSCALE_UM` 를 `8.0`(mm) 으로 바꾸세요.

  정품 라이브러리의 실제 변위 단위가 확정되면 이에 맞춰 `engine/utils.ts` 후처리를 정리해야 합니다.
