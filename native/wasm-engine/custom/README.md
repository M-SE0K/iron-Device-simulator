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
npm run bootstrap    # 또는 npm run wasm:build && npm run dev
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

## 정품 알고리즘 도착 시 소스 난독화 켜기

이 폴더에 정품 vendor 알고리즘을 드롭인하는 순간부터는 지킬 가치가 있는 소스가 된다.
`FF_PROT_HARDEN=1 ./build-wasm.sh`(또는 `FF_PROT_HARDEN=1 npm run wasm:build`)로 빌드하면
`../build-wasm.sh`가 자동으로 다음을 적용한다:

1. **소스 레벨 난독화**(`../obfuscate-source.sh`, 이 항목) — Tigress가 PATH에 있을 때만.
2. Emscripten 하드닝 플래그(`-flto -g0 --closure 1`)
3. `wasm-opt` 스트립/재최적화
4. JS 글루 코드 난독화(javascript-obfuscator)

1번(Tigress)은 별도 설치가 필요하다 — 자동 설치되지 않고, 없어도 2~4는 정상 진행된다:

```bash
# https://tigress.wtf 에서 라이선스 등록 후 다운로드/설치 (자동화 불가)
which tigress   # PATH에 잡히는지 확인

FF_PROT_HARDEN=1 npm run wasm:build
```

`../obfuscate-source.sh`는 `InitOpaque`/`Flatten`/`EncodeArithmetic`/`AddOpaque` 조합을
쓰고, **export 심볼 4개(`ff_prot_init`/`set_param`/`start_exec`/`stop_exec`)는 Flatten
대상에서 제외**한다 — 이름 자체가 바뀌는 변환은 없으니 계약은 안 깨지지만, 함수 export
심볼이 바뀌면 `wasm-client.ts`가 못 찾으므로 커스텀 알고리즘 쪽에서 함수명을 직접
바꾸지 않는 한 안전하다. 다른 `--Transform` 조합을 쓰고 싶으면 이 파일을 직접 수정한다.
