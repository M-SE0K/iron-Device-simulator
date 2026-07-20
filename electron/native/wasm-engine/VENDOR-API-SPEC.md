# libirontune 정품 API — 현재 호출 방식 vs 요청해야 할 스펙

이 문서는 (1) 지금 이 프로젝트가 `ff_prot_*`를 실제로 어떻게 호출하고 있는지와, (2) Iron
Device Corp.에 정품 `libirontune.so`/원본 소스를 요청할 때 **확인·요청해야 할 함수 시그니처
목록**을 정리한다. (2)는 `../iron-Device/`(리포 밖, 이 저장소와 별도 폴더)에 있던 실제 벤더
산출물(스트립 안 된 `.so` + 참조 래퍼 소스)을 `nm`/`objdump`로 역검증해 얻은 결과다 — 공식
문서가 아니라 **바이너리 역추적 근거**이므로, 벤더가 공식 스펙을 주면 그걸 우선한다.

관련 문서: [`README.md`](./README.md)(이 폴더 스텁 자체의 설명), 프로젝트 루트
`CLAUDE.md`의 "V/I sensing (real hardware loop) — roadmap" 절.

---

## 1. 현재 코드가 호출하는 방식 (as-is, 이 프로젝트 스텁 기준)

### 1.1 세션 라이프사이클

```
openClientWasmSession()                         // wasm-client.ts:107
  → mod._ff_prot_init()                          // 세션 오픈 시 1회
  → mod._ff_prot_set_param()                     // 세션 오픈 시 1회 (인자 없음, 사실상 NOP)

(세션 동안 프레임마다 반복)
createAnalysisFrame(pcm, params, layout, config) // utils.ts:103
  → deinterleave(pcm, samplesPerCh)               // interleave(V I V I) → planar(VV..II..)
  → layout.writePlanar(bufPtr, planar)            // HEAP16에 기록
  → layout.execAnalysis(bufPtr, tempPtr, excPtr, ambientTemp)
      → mod._ff_prot_start_exec(                  // wasm-client.ts:39-50
            bufPtr,
            config.samplesPerCh,
            BYTES_PER_SAMPLE,   // = 2 (core.ts)
            CHANNELS,           // = 2 (core.ts)
            ambientTemp,
            tempPtr,
            excPtr,
        )                        // 7-인자로 정렬 완료(2026-07-16) — 아래 3장 참고
  → layout.readResults(tempPtr, excPtr)           // HEAP32에서 [T0,T1,E0,E1] 읽기
  → applyPostCorrection(rawTemp, rawExc, params)   // SPEAKER_PROFILES × powerTempMult (임시 규약)

session.close()
  → mod._ff_prot_stop_exec()                       // ff_prot_end()는 호출 안 함(존재 자체를 모름)
  → mod._free(bufPtr/tempPtr/excPtr)
```

호출부 실제 위치:
- `src/features/audio/lib/engine/adapters/wasm-client.ts:39-50` (`ClientWasmMemoryLayout.execAnalysis`)
- `src/features/audio/lib/engine/adapters/wasm-client.ts:117-120` (`openClientWasmSession` — init/set_param)
- `src/features/audio/lib/engine/adapters/wasm-client.ts:129-136` (`close` — stop_exec)
- `src/features/audio/lib/engine/utils.ts:103-136` (`createAnalysisFrame` — 프레임 파이프라인)
- `src/features/audio/lib/engine/core.ts:16-41` (프레임 포맷 상수, `EngineRuntimeConfig`)

### 1.2 현재 스텁이 선언한 시그니처 (`ff_prot.h`)

**(2026-07-16 정렬 완료)** 아래 7-인자 시그니처는 2.2절에서 검증된 실제 벤더 시그니처와 일치한다.

```c
int ff_prot_init(void);
int ff_prot_set_param(void);   // 인자 없음, 사실상 NOP
int ff_prot_start_exec(void    *buf,
                       uint32_t samples_per_ch,
                       uint32_t bytes_per_sample,
                       uint32_t channels,
                       int32_t  amb_temp,
                       void    *spk_temp,
                       void    *spk_exc);
int ff_prot_stop_exec(void);
// ff_prot_end() 없음 — 아래 3.3절
```

⚠️ 단, `sample_rate_hz`가 인자로 안 들어온다는 것과 dt/LPF 계산에 필요한 시간 정보를 실제
라이브러리가 어디서 얻는지는 별개 문제다 — 후자는 여전히 미확인이라(4장 항목 #1) 이 참조
스텁은 `ff_prot.c`의 `DEFAULT_SAMPLE_RATE_HZ`(고정 48 kHz) 근사로 대체했다.

### 1.3 PCM/파라미터 규약 (현재 코드 기준)

- 와이어 포맷: **int16**, 2ch, interleaved(V I V I…) → `deinterleave()`가 **planar**(VV…II…)로 변환 후 전달.
- `samples_per_ch`는 고정값이 아니라 Calibration UI(`bufferSize`)에서 세션마다 재정의되는 런타임
  값 (기본 480 samples/ch, 48 kHz 기준 10 ms/frame). `sampleRate`는 캡처/와이어 세션 설정에는
  계속 쓰이지만 `ff_prot_start_exec` 인자로는 더 이상 전달되지 않는다(위 1.2절).
- `amb_temp`: Calibration UI `ambientTemp` (기본 25°C).
- 출력 `spk_temp[2]`/`spk_exc[2]`(int32, ch0=V/ch1=I)에 `SPEAKER_PROFILES`(`speakerModel`) ×
  `powerTempMult(ampOutputPower)`를 곱하는 **TS 쪽 후처리**가 붙는다 — `set_param`이 NOP이라
  스피커 모델/전력을 엔진이 못 받기 때문에 생긴 임시 규약.

---

## 2. `../iron-Device/`에서 확인한 실제 벤더 산출물 (검증됨)

`../iron-Device/`(이 리포 밖) 폴더에 다음이 있었다:
- `ff_prot.h` / `ff_prot.c` — Android/Linux Foundation 스타일 **래퍼** 참조 소스.
  `audio_ff_prot_init/processing/stop`를 선언하고, 내부에서 우리가 구현해야 할
  `ff_prot_init/set_param/start_exec/stop_exec`를 **호출**한다(정의는 없음 — 외부 심볼).
- `libirontune.so`, `libirontune_legacy.so` — 스트립 안 된 실제 ELF 바이너리(x86-64).

### 2.1 `.so`가 export하는 전체 심볼 (`nm libirontune.so`)

```
ff_prot_end            ff_prot_init            ff_prot_set_param
ff_prot_start_exec     ff_prot_stop_exec
sm_power_meter_init    sm_power_meter_set_param  sm_power_meter_exec
sm_power_meter_get_param  sm_power_meter_end
biquad_filter  biquad_filter_imp  biquad_filter_thermal
drc_func  fix_exc_cal_mon  lpf_rms_sq_t
math_log10  math_log2  math_pow10  report_callback
```

(`libirontune_legacy.so`엔 위 전부 + `fix_exc_cal`, `lpf_rms_sq_16`, `lpf_rms_sq_avg`,
`norm_l`, `thermal_pt_feedback_ctrl`, `calculateLog10`, `calculatePow10` 추가 — 구버전은
온도 피드백 제어 루프가 더 명시적으로 분리돼 있었던 것으로 보임.)

### 2.2 `ff_prot_start_exec` 실제 시그니처 (근거 2건 — 소스 + 디스어셈블)

**근거 A — 래퍼 소스의 실제 호출부** (`../iron-Device/ff_prot.c`):
```c
ret = ff_prot_start_exec((void *) data, sample_per_channel, byte_per_sample,
                          gLibHandle.channels, amb_temp, spk_temp_fb, spk_exc_fb);
// 7개 인자. sample_rate_hz 없음.
```

**근거 B — `objdump -d libirontune.so`의 `ff_prot_start_exec` 프롤로그**:
```
movq  %rdi, ...   ; arg1 buf
movl  %esi, ...   ; arg2 samples_per_ch
movl  %edx, ...   ; arg3 bytes_per_sample
movl  %ecx, ...   ; arg4 channels
movl  %r8d, ...   ; arg5 amb_temp
movq  %r9,  ...   ; arg6 spk_temp*
movq  0x10(%rbp), %rax  ; arg7 spk_exc* (스택에서 — 7번째 인자)
```
System V AMD64 규약상 정수/포인터 인자는 `rdi,rsi,rdx,rcx,r8,r9` 6개 레지스터 다음
스택으로 넘어간다. 여기선 정확히 레지스터 6개 + 스택 1개 = **7개**만 쓰이고,
실수 인자용 레지스터(`xmm0-7`)는 전혀 참조되지 않는다 → **`sample_rate_hz`(double) 자리 자체가
실제 라이브러리엔 없다.**

**결론 — 실제 시그니처(추정 아님, 검증됨):**
```c
int ff_prot_start_exec(void *buf, uint32_t samples_per_ch, uint32_t bytes_per_sample,
                        uint32_t channels, int32_t amb_temp,
                        int32_t *spk_temp, int32_t *spk_exc);
```

### 2.3 `ff_prot_end()` — 우리 스텁에 없는 함수

`.so`가 별도로 export한다. 디스어셈블 결과 현재 빌드에선 `return 0;`뿐인 NOP이지만,
API 표면(헤더)에는 존재해야 한다. 우리 `ff_prot.h`/`ff_prot.c`엔 선언조차 없다.

### 2.4 `ff_prot_stop_exec()`이 `sm_power_meter_end()`를 호출함

디스어셈블 결과 `ff_prot_stop_exec`의 본문이 `sm_power_meter_end()`를 호출하고 리턴한다.
즉 실제 라이브러리엔 `ff_prot_*` 외에 **별도의 파워미터 서브모듈**(`sm_power_meter_init/
set_param/exec/get_param/end`)이 있고 생명주기가 엮여 있다 — 우리 프로젝트엔 이 개념 자체가
없다. V/I 실측 입력이 `ff_prot_start_exec` 한 곳이 아니라 이 서브모듈과 관련될 가능성.

### 2.5 `ff_prot_set_param()` — NOP이라는 우리 가정은 맞음

디스어셈블: `push rbp; mov eax,0; pop rbp; ret` 뿐, 인자 레지스터를 전혀 읽지 않음.
우리 스텁의 "현재 사실상 NOP" 가정은 실제와 일치.

### 2.6 내부 구조가 우리 물리 근사 모델과 다름 (참고용, 액션 아이템 아님)

`biquad_filter*`(다단 IIR, `_thermal` 전용 스테이지 포함), `drc_func`(다이내믹 레인지
컴프레션), `fix_exc_cal_mon`(익스커션 보정 모니터), `lpf_rms_sq_t`(스무딩된 RMS² 전력
추정) 등 다단 파이프라인이 있고, 디스어셈블에 `sarl $0xf`(÷32768), `imull $0x3e8; sarl
$0x17`(×1000÷2²³ 근사) 같은 **고정소수점(Q15/Q23풍) 연산**이 보인다. 우리 스텁은 double
RC 적분 + 1-pole LPF 단일 스테이지 — 챠트 파이프라인 검증용으로는 충분하나 물리 모델
구조 자체는 실제와 다르다(이미 README에 "정품 아님"으로 명시돼 있던 사실의 구체적 근거).

---

## 3. 우리 스텁과의 불일치 요약

| 항목 | 우리 스텁 | 실제 벤더(.so 검증) | 상태 |
|---|---|---|---|
| `ff_prot_start_exec` 인자 개수 | 7개 (`sample_rate_hz` 없음) | 7개 (`sample_rate_hz` 없음) | ✅ 정렬 완료(2026-07-16) — 단, dt 계산용 시간 정보 출처는 미확인(4장 #1) |
| `ff_prot_end()` | 없음 | export됨(현재는 NOP) | ❌ 누락 — 헤더/스텁에 추가 필요 |
| `ff_prot_set_param()` | NOP 가정 | 실제도 NOP | ✅ 일치 |
| `ff_prot_init()` | 상태 리셋 | 상태 배열 memset | ✅ 개념 일치 |
| planar 변환 시점 | 호출 전 TS에서 deinterleave | 래퍼가 호출 전 C에서 deinterleave | ✅ 일치 |
| PCM 비트폭 | int16 고정 | `format` enum으로 16/32bit 둘 다 지원(기본 16bit) | ⚠️ 우리 선택은 근거 있으나 고정 아님 |
| 파워미터 서브모듈(`sm_power_meter_*`) | 없음 | `stop_exec`에 엮여 있음 | ❓ 미확인 — V/I 실측과 관계 확인 필요 |
| 내부 신호처리(biquad/DRC/캘리브레이션) | 없음(RC+LPF 근사) | 다단 파이프라인 + 고정소수점 | (참고용, 스텁 목적상 허용) |

---

## 4. 벤더(Iron Device Corp.)에 요청·확인해야 할 스펙 체크리스트

1. **`ff_prot_start_exec` 정식 시그니처** — 7-인자(검증된 안)가 맞는지, 맞다면
   `sample_rate_hz`(혹은 버퍼 길이 계산에 필요한 시간 정보)는 어디서 오는지
   (컴파일 타임 고정? `set_param` 확장 시 들어갈 자리?).
2. **`ff_prot_end()`의 역할** — `stop_exec`과 별도로 호출해야 하는지, 호출 순서
   (`stop_exec` 후 `end`? 세션당 1회? 앱 종료 시 1회?).
3. **`sm_power_meter_*` 서브모듈** — 이게 V/I(전압/전류) 실측 입력을 받는 API인지,
   `ff_prot_*`와 별도로 우리가 직접 호출/초기화해야 하는지, 아니면 `ff_prot_*` 내부에서만
   쓰이고 외부 노출은 불필요한지.
4. **`ff_prot_set_param()`이 실제로 파라미터를 받는 버전이 있는지** — 지금 라이브러리는
   무인자 NOP이지만, 스피커 모델/정격전력을 받는 확장판이 있는지, 있다면 시그니처·타입
   (문자열 enum vs 숫자 코드)·단위(W).
5. **입력 PCM 비트폭** — `format=1(16bit)`이 기본 경로로 보이는데, 이 프로젝트가 16bit로
   고정해도 되는지, 아니면 실제 배포 환경은 24/32bit(`format=3/4`)를 쓰는지.
6. **출력 단위/스케일** — `spk_temp`/`spk_exc`가 그대로 °C/µm인지, 아니면 고정소수점
   변환(디스어셈블에서 관찰된 것과 유사한 스케일)이 더 필요한지.
7. **빌드 형태** — 이 프로젝트는 서버/네이티브 FFI 없이 **브라우저 WASM(Emscripten)
   전용**이다. `.so` 바이너리만으로는 통합 불가 — Emscripten으로 컴파일 가능한 원본
   C/C++ 소스를 받을 수 있는지, 불가하다면 벤더가 WASM 빌드를 직접 제공할 수 있는지.

---

## 5. 근거 원문 (재현 방법)

```bash
# 심볼 목록
nm -D libirontune.so | grep -i "ff_prot\|sm_power\|biquad\|drc\|calib\|lpf\|math_"

# ff_prot_start_exec 프롤로그 확인
objdump -d libirontune.so | awk '/<ff_prot_start_exec>:/{f=1} f{print} /ret/{if(f)exit}'
```

`../iron-Device/`는 이 저장소 밖(`../`)에 있는 로컬 폴더이며 git 추적 대상이 아니다 —
이 문서는 그 안의 내용을 스냅샷으로 옮겨 적은 것이므로, 원본 파일이 갱신되면 이 문서도
다시 검증해야 한다.
