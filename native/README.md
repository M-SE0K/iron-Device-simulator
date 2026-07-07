# native/ — ff_prot 참조 구현 (검증용 `libirontune.so` 스텁)

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
| `ff_prot_start_exec` | `int (void* buf, uint32 samples_per_ch, uint32 bytes_per_sample, uint32 channels, int32 amb_temp, double sample_rate_hz, void* spk_temp, void* spk_exc)` |
| `ff_prot_stop_exec` | `int (void)` |

- **입력 버퍼**: `engine/utils.ts` 의 `deinterleave()` 결과인 **planar** int16 PCM (`[ch0 전체][ch1 전체]`), 2ch, `amb_temp=25`. `samples_per_ch`/`sample_rate_hz`는 고정값이 아니라 Calibration UI(bufferSize/sampleRate)에서 세션마다 넘어오는 런타임 값이다(기본 480 samples/ch, 48 kHz = 10 ms/frame) — `dt = samples_per_ch / sample_rate_hz`로 열 적분 스텝에 직접 반영된다.
- **출력**: `spk_temp[ch]` = 보이스코일 온도 `[°C]`, `spk_exc[ch]` = 콘 피크 변위 `[µm]`, int32, ch0=L / ch1=R.

## 모델 요약

1. 블록 RMS → 전기 소산 전력 `P ∝ rms²`
2. 1차 열 RC 적분 `T ← T + (dt/τ)(amb + Rth·P − T)` → 온도가 천천히 상승 (상태 누적)
3. LF 강조 1-pole 저역통과의 블록 피크 → 변위(µm). 저주파일수록 크고 고주파일수록 작음.

튜닝 상수(`NOMINAL_POWER_W`, `THERMAL_RES_C_W`, `THERMAL_TAU_S`, `EXC_LPF_FC_HZ`, `EXC_FULLSCALE_UM`)는 `ff_prot.c` 상단에 모여 있습니다.

## 순수 C 셀프테스트 (물리 모델 검증용, 앱과 무관)

```bash
# Linux x86-64 전용
cd native
make selftest        # 순수 C 셀프테스트(온도 상승 + L/R 변위 차이) 확인
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
