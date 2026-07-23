# electron/native/wasm-engine/ — ff_prot 참조 구현 (검증용 `libirontune.so` 스텁)

> 이 폴더는 `electron/` 밑에 있지만 Electron 전용이 아닙니다 — 컴파일 산출물
> (`public/wasm/ff_prot.{js,wasm}`)은 순수 웹 빌드(`build:desktop`)에도 그대로 쓰입니다.

> ⚠️ **정품 아님.** Iron Device 정품 `libirontune.so` 의 원본 소스를 아직 받지 못해
> 임의로 구성한 **물리 근사 모델**입니다. 실제로는 이 `.c` 소스를 Emscripten으로
> 브라우저 타깃 WASM(`public/wasm/ff_prot.{js,wasm}`, `build-wasm.sh`)으로 컴파일해
> `src/features/audio/lib/engine/adapters/wasm-client.ts`가 브라우저 안에서 직접
> 호출한다 — `.so`/koffi FFI 로딩 경로는 쓰이지 않는다. 정품 소스를 받으면 이
> 디렉터리는 폐기합니다.

## 내 알고리즘 넣기 (drop-in)

이 폴더는 스텁을 **본인 C 알고리즘으로 갈아끼우는 것**을 전제로 설계돼 있다. 계약은 `ff_prot.h`의 4개 함수가 전부다.

1. **드롭인** — 본인 `.c`/`.h` 파일들을 **`custom/` 폴더에 넣는다. 파일명 제약 없음.**
   - `custom/`에 `.c`가 하나라도 있으면 `build-wasm.sh`가 **스텁(`ff_prot.c`) 대신 `custom/*.c`만** 컴파일한다 — 스텁을 지우거나 덮어쓸 필요가 없어 `git pull`의 스텁 갱신과 충돌하지 않는다(래퍼 예시 포함 상세: `custom/README.md`).
   - 빌드 소스 우선순위: `FF_PROT_SRCS="a.c b.c"` 명시 > `custom/*.c` > 폴더 내 `*.c`(스텁). 파일명에 `selftest`가 들어가면 항상 제외.
   - (구식 경로) 스텁 `ff_prot.c`를 직접 덮어써도 되지만, 그 경우 같은 심볼(`ff_prot_*`)을 정의한 파일이 폴더에 공존하면 **중복 심볼로 링크가 깨진다**는 점에 유의.
2. **시그니처 유지** — `ff_prot_init` / `ff_prot_set_param` / `ff_prot_start_exec`(9-인자) / `ff_prot_stop_exec` 4개를 `ff_prot.h` 선언 그대로 export해야 한다(아래 표 참고). 함수명이 다른 기존 알고리즘이라면 이 4개 이름으로 위임하는 얇은 래퍼 `.c` 하나를 같이 넣으면 된다. 함수를 **추가로** export하려면 `build-wasm.sh`의 `-sEXPORTED_FUNCTIONS` 목록에 `_함수명`을 등록한다(호출부는 `wasm-client.ts`).
3. **빌드 + 실행** — 리포 루트에서:
   ```bash
   npm run bootstrap    # 클론 직후 원커맨드: 환경 확인 → npm install → wasm:build → dev 서버
   # 또는 개별 실행: npm run wasm:build && npm run dev
   ```
   `emcc`가 없어도 **Docker만 있으면 된다** — `build-wasm.sh`가 emscripten/emsdk 이미지로 자동 폴백한다. → http://localhost:3000 에서 마이크/파일 입력으로 바로 확인.
4. **지켜야 할 버퍼 규약** (아래 "함수 시그니처" 절의 상세 참고) — `buf`는 **planar** int16 PCM(In/Out, 감쇠 결과를 in-place로 되씀), `samples_per_ch`는 세션마다 바뀌는 런타임 값(기본 480), `sample_rate_hz` 인자는 **없음**, 출력 단위는 `spk_temp` °C / `spk_exc` µm(int32).
5. **값 확인** — `npm run wasm:build:debug`(`FF_PROT_DEBUG_VI=1`)로 빌드하면 프레임마다 V/I 입력이 콘솔에 덤프된다(대량 출력 — 지연 측정과 병행 금지). 순수 C 수준 검증은 `selftest.c`를 본인 구현에 맞게 고쳐 `make selftest`(Linux x86-64)로 돌릴 수 있다.

## 함수 시그니처 (adapters/wasm-client.ts 와 1:1)

| 함수 | 시그니처 |
|---|---|
| `ff_prot_init` | `int (void)` |
| `ff_prot_set_param` | `int (void)` — 현재 사실상 NOP |
| `ff_prot_start_exec` | `int (void* buf, uint32 samples_per_ch, uint32 bytes_per_sample, uint32 channels, int32 amb_temp, void* spk_temp, void* spk_exc, const void* v_sensing, const void* i_sensing)` — 9-인자. **`buf`는 In/Out** — 보호 감쇠 결과를 같은 버퍼에 되쓴다. `v_sensing`/`i_sensing`은 2026-07-21 새로 확인된 벤더 소스 기준 인자로, 실제 캡쳐된 V/I sensing 데이터를 받는다 — 둘 다 `int16[samples_per_ch]` **단일(모노) 스트림**(channels별 배열 아님). 클라이언트는 `buf`를 디인터리브한 ch0(V)/ch1(I)을 그대로 넘긴다 — MCHStreamer가 캡처 채널 수와 무관하게 실측 V/I 센스를 항상 ch0/ch1에 싣기 때문(2026-07-23 정정 — 과거의 ch2/ch3 추출은 오인이었음). 따라서 이 클라이언트 경로에서는 항상 non-NULL이고, NULL(RMS 근사 폴백)은 사실상 발생하지 않는다(자세한 내용은 `ff_prot.h` 상단 주석) |
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

1. 블록 RMS → 전기 소산 전력 `P ∝ rms²` (`v_sensing`/`i_sensing`이 둘 다 주어지면
   pass A(게인 한도 산출)·pass C(상태 보고)의 전력을 실측 `P = mean(v·i)`로 대체 —
   클라이언트가 `buf`의 ch0(V)/ch1(I)을 그대로 센싱 인자로 넘기므로(`frame-core.ts`의
   `selectSensing`, 2026-07-23 정정) 이 경로에서는 항상 실측치가 쓰인다. 변위(excursion)
   추정은 여전히 PCM 기반)
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
실제로 시뮬레이터에 물리는 방법은 리포 루트에서 `npm run bootstrap`(또는 `npm run
wasm:build && npm run dev`). `emcc`가 없으면 `build-wasm.sh`가 Docker(emscripten/emsdk)로
자동 폴백한다.

## ⚠️ 단위 주의 (engine/utils.ts 후처리와의 관계)

`engine/utils.ts` 의 `applyPostCorrection()` 은 raw 출력에 `profile.tempMult · powerTempMult()` (온도) / `profile.excMult` (변위)만 곱해 **그대로** 화면 값으로 씁니다.

- **온도**: 이 참조 구현은 `°C` 정수를 출력하므로 `tempMult≈1` 에서 그대로 `°C` 로 표시됩니다. (OK)
- **변위**: 이 참조 구현은 `µm` 를 출력합니다. mock 모델의 `mm` 축과 맞추려면
  - TS 쪽에서 `rawExc/1000` 하거나,
  - `SPEAKER_PROFILES[...].excMult` 를 0.001 스케일로 두거나,
  - 이 파일의 `EXC_FULLSCALE_UM` 를 `8.0`(mm) 으로 바꾸세요.

  정품 라이브러리의 실제 변위 단위가 확정되면 이에 맞춰 `engine/utils.ts` 후처리를 정리해야 합니다.
