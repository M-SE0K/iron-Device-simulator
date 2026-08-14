# custom/debug/ — 디버그용 참조 알고리즘

파이프라인(입력→WASM→출력) 자체를 검증하기 위한 최소 알고리즘 3종. 각 파일은
`ff_prot_*` 4개 심볼을 전부 구현하는 독립 소스라 **한 번에 하나만** 빌드 대상으로
골라야 한다(`../README.md` 참고 — `custom/*.c`는 자동 감지되지만 이 폴더는
서브폴더라 자동 글롭 대상이 아니다. `FF_PROT_SRCS`로 명시 지정한다).

| 파일 | 동작 |
|---|---|
| `passthrough.c` | 원음을 그대로 흘려보낸다 (튜닝/감쇠 없음, buf 미수정) |
| `mute.c` | 모든 채널을 완전히 묵음 처리한다 (buf 전부 0) |
| `half_gain.c` | 원음을 게인 0.5(50% 감소)로 고정 감쇠한다 |

세 파일 모두 `../protection.c`와 동일한 근사 모델(1-pole LF LPF 피크 → 변위,
RC 열적분 → 온도)로 채널별 exc/temp를 **실제 출력 신호 기준**으로 계산해
반환한다 — 하드코딩 값이 아니다:

- `passthrough`/`half_gain`: 각각 원음/반감된 신호의 세기에 비례해 exc/temp가 움직인다.
- `mute`: 출력이 무음이므로 exc≈0, temp는 amb_temp로 서서히 수렴한다(무음 신호를
  그대로 스캔한 결과일 뿐, 특별 취급이 아니다).

v_sensing/i_sensing이 함께 들어오면(passthrough/half_gain) 실측 전력을 buf RMS
근사 대신 사용한다 — `../protection.c`와 동일한 우선순위.

## 빌드

```bash
# 리포 루트에서, 원하는 파일 하나만 지정
cd native/wasm-engine
FF_PROT_SRCS=custom/debug/passthrough.c ./build-wasm.sh
FF_PROT_SRCS=custom/debug/mute.c        ./build-wasm.sh
FF_PROT_SRCS=custom/debug/half_gain.c   ./build-wasm.sh
```

또는 리포 루트 `npm` 스크립트를 쓴다면 동일하게 환경변수만 얹으면 된다:

```bash
FF_PROT_SRCS=custom/debug/half_gain.c npm run build:wasm
```

확인 후에는 반드시 플래그 없이 다시 빌드해 `public/wasm/`를 원래 알고리즘으로
복구할 것.
