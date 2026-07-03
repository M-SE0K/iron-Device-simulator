# native/ — ff_prot 참조 구현 (검증용 `libirontune.so` 스텁)

> ⚠️ **정품 아님.** Iron Device 정품 `libirontune.so` 의 원본 소스를 아직 받지 못해,
> `src/features/audio/lib/native-engine.ts` 의 koffi 바인딩 시그니처에 맞춰 임의로 구성한
> **물리 근사 모델**입니다. `.so` 로딩 → FFI 호출 → 온도/변위 차트까지 전체 파이프라인이
> 정상 동작하는지 **빠르게 검증**하는 용도이며, 정품 소스를 받으면 이 디렉터리는 폐기합니다.

## 함수 시그니처 (native-engine.ts 와 1:1)

| 함수 | 시그니처 |
|---|---|
| `ff_prot_init` | `int (void)` |
| `ff_prot_set_param` | `int (void)` — 현재 사실상 NOP |
| `ff_prot_start_exec` | `int (void* buf, uint32 samples_per_ch, uint32 bytes_per_sample, uint32 channels, int32 amb_temp, void* spk_temp, void* spk_exc)` |
| `ff_prot_stop_exec` | `int (void)` |

- **입력 버퍼**: `native-engine.ts` 의 `deinterleave()` 결과인 **planar** int16 PCM (`[ch0 전체][ch1 전체]`), 480 samples/ch × 2ch, 48 kHz(10 ms/frame), `amb_temp=25`.
- **출력**: `spk_temp[ch]` = 보이스코일 온도 `[°C]`, `spk_exc[ch]` = 콘 피크 변위 `[µm]`, int32, ch0=L / ch1=R.

## 모델 요약

1. 블록 RMS → 전기 소산 전력 `P ∝ rms²`
2. 1차 열 RC 적분 `T ← T + (dt/τ)(amb + Rth·P − T)` → 온도가 천천히 상승 (상태 누적)
3. LF 강조 1-pole 저역통과의 블록 피크 → 변위(µm). 저주파일수록 크고 고주파일수록 작음.

튜닝 상수(`NOMINAL_POWER_W`, `THERMAL_RES_C_W`, `THERMAL_TAU_S`, `EXC_LPF_FC_HZ`, `EXC_FULLSCALE_UM`)는 `ff_prot.c` 상단에 모여 있습니다.

## 빌드 & 검증

```bash
# Linux x86-64
cd native
make                 # → libirontune.so
make selftest        # 순수 C 셀프테스트(온도 상승 + L/R 변위 차이) 확인

# macOS/Apple Silicon 은 x86-64 Docker 안에서 빌드 (scripts/run-native-docker.sh 와 동일 환경)
```

## 시뮬레이터에 물리기

```bash
# 리포 루트에서 (native 엔진 모드)
USE_MOCK=false SO_PATH=/abs/path/to/native/libirontune.so npx tsx server.ts
```

또는 `scripts/run-native-docker.sh` / `run-native-linux.sh` 의 `SO_HOST` 를 이 `libirontune.so` 경로로 지정.

## ⚠️ 단위 주의 (native-engine.ts 후처리와의 관계)

`native-engine.ts` 는 raw 출력에 `profile.tempMult · powerTempMult()` (온도) / `profile.excMult` (변위)만 곱해 **그대로** 화면 값으로 씁니다.

- **온도**: 이 참조 구현은 `°C` 정수를 출력하므로 `tempMult≈1` 에서 그대로 `°C` 로 표시됩니다. (OK)
- **변위**: 이 참조 구현은 `µm` 를 출력합니다. mock 모델의 `mm` 축과 맞추려면
  - TS 쪽에서 `rawExc/1000` 하거나,
  - `SPEAKER_PROFILES[...].excMult` 를 0.001 스케일로 두거나,
  - 이 파일의 `EXC_FULLSCALE_UM` 를 `8.0`(mm) 으로 바꾸세요.

  정품 라이브러리의 실제 변위 단위가 확정되면 이에 맞춰 `native-engine.ts` 후처리를 정리해야 합니다.
