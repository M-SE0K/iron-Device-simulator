# custom/ — 본인 알고리즘 드롭인 폴더

**여기에 본인 C 소스(`.c`/`.h`)를 넣으면 됩니다 — 파일명 제약 없음.**

이 폴더에 `.c` 파일이 하나라도 있으면 `build-wasm.sh`가 상위 폴더의 참조 스텁
(`../ff_prot.c`) 대신 **이 폴더의 소스만** 컴파일합니다. 스텁을 지우거나 덮어쓸
필요가 없으므로, 업스트림(`git pull`)의 스텁 갱신과 본인 코드가 충돌하지 않습니다.

```bash
# 예: 다중 소스 알고리즘
custom/
  my_algo.c          # ff_prot_* 4개 함수 구현 (또는 아래 래퍼 방식)
  my_filter.c
  my_filter.h

# 리포 루트에서:
npm run bootstrap    # 또는 npm run build:wasm -- --dev && npm run dev
```

## 지켜야 할 계약 (`../ff_prot.h`)

파일명은 자유지만 **export 심볼 4개는 고정**입니다 — JS 쪽(`wasm-client.ts`)이 이
심볼명을 직접 호출하기 때문입니다:

| 함수 | 시그니처 |
|---|---|
| `ff_prot_init` | `int (void)` |
| `ff_prot_set_param` | `int (void)` |
| `ff_prot_start_exec` | 9-인자 — `../ff_prot.h` 선언 참고 |
| `ff_prot_stop_exec` | `int (void)` |

기존 알고리즘의 함수명이 다르면 위임 래퍼 하나만 추가하면 됩니다:

```c
/* custom/wrapper.c — 함수명이 다른 기존 알고리즘 매핑 예시 */
#include "ff_prot.h"        /* 상위 폴더 헤더 — build-wasm.sh 가 -I. 로 잡아준다 */
#include "my_algo.h"

int ff_prot_init(void)      { return my_algo_setup(); }
int ff_prot_set_param(void) { return 0; }
int ff_prot_start_exec(void *buf, uint32_t samples_per_ch, uint32_t bytes_per_sample,
                       uint32_t channels, int32_t amb_temp, void *spk_temp, void *spk_exc,
                       const void *v_sensing, const void *i_sensing)
{
    return my_algo_process(buf, samples_per_ch, channels, amb_temp,
                           spk_temp, spk_exc, v_sensing, i_sensing);
}
int ff_prot_stop_exec(void) { return my_algo_teardown(); }
```

- 버퍼 규약(planar int16 In/Out, 출력 단위 °C/µm 등)은 `../ff_prot.h` 상단 주석과
  `../README.md`의 "내 알고리즘 넣기" 절 참고.
- 함수를 **추가로** export 하려면 `../build-wasm.sh`의 `-sEXPORTED_FUNCTIONS` 목록에 등록.
- 파일명에 `selftest`가 들어가면 빌드에서 제외됩니다(자체 `main` 보유 테스트용 관례).
- 특정 파일만 골라 빌드: `FF_PROT_SRCS="custom/a.c custom/b.c" ./build-wasm.sh`
  (`FF_PROT_SRCS`는 custom/ 자동 감지보다 우선).

## 정품 알고리즘 도착 시 난독화 켜기

이 폴더에 정품 vendor 알고리즘을 드롭인하는 순간부터는 지킬 가치가 있는 소스가 된다.
`FF_PROT_HARDEN=1 ./build-wasm.sh`(또는 `FF_PROT_HARDEN=1 npm run build:wasm`)로 빌드하면
`../build-wasm.sh`가 자동으로 다음을 적용한다:

1. Emscripten 하드닝 플래그(`-flto -g0 --closure 1`)
2. `wasm-opt` 스트립/재최적화 (Binaryen, Apache-2.0)
3. **구조 변형**: `wasm-mutate`로 제어흐름/명령을 의미 보존하며 무작위 변형(기본 200회 누적)
4. **상수 난독화**: `../obfuscate-wasm-consts.js`가 `.wasm` 산출물의 `f64/f32/i32/i64.const`
   리터럴을 XOR 마스킹으로 은닉 (wabt, Apache-2.0)
5. JS 글루 코드 난독화(javascript-obfuscator, BSD-2)

> 과거엔 여기에 **C 소스 레벨 난독화(Tigress)** 가 있었으나 폐기했다 — 상용 라이선스 협의가
> 필요하고, PATH에 없으면 어차피 no-op이라 실효가 낮았다. 그 역할(제어흐름 평탄화·불투명
> 조건문·산술 인코딩)은 위 3(wasm-mutate)+4(상수 XOR)의 **WASM 바이너리 레벨 처리**로
> 대체했다. 모두 무료(Apache/BSD)이고, C 소스는 전혀 건드리지 않으므로 어떤 알고리즘을
> 드롭인해도 값/함수 이름을 몰라도 자동 적용된다.

**구조 변형(3)만 도구 설치가 필요**하다 — 없으면 비파괴적으로 건너뛰고 나머지는 정상 진행된다.
`wasm-mutate`가 export 함수의 관찰 가능한 동작을 보존하므로 `ff_prot_*` 4개 심볼 계약은
안 깨진다:

```bash
# 권장: cargo install wasm-tools  (standalone wasm-mutate 바이너리도 인식)
cargo install wasm-tools
which wasm-tools   # PATH에 잡히는지 확인

FF_PROT_HARDEN=1 npm run build:wasm
```

조정 노브(전부 선택):

- `FF_PROT_MUTATE_ITERS`(기본 200) — 구조 변형 누적 횟수. 0이면 이 단계 생략.
- `FF_PROT_OBF_INT`(기본 on) — 정수 상수 XOR 치환 on/off. 실수(f64/f32)는 항상 치환.
- `FF_PROT_OBF_INT_MIN`(기본 8) — 절댓값이 이 미만인 사소한 정수(오프셋·인덱스류)는 건너뜀.
- `FF_PROT_OBF_INT_RATE`(기본 0.5) — 남은 정수 중 치환 비율(바이너리 팽창·성능 절충용).

⚠️ 상수 난독화(4)는 반드시 마지막 WASM 변형이어야 한다 — 이후 어떤 최적화 패스도 돌리면
XOR 패턴이 상수 폴딩으로 원복된다. `../build-wasm.sh`가 3→4 순서를 강제한다.
