# docker/verify — 배포 전 클론 무결성 검증

프로덕션 브랜치에 올리기 전에, **알고리즘팀이 이 리포를 클론해서 개발 환경을 세팅하고
자기 알고리즘을 빌드하는 전 과정**을 격리된 컨테이너에서 재현한다.

잡으려는 사고는 하나다:

> 내 머신에서는 되는데, 갓 클론한 사람에게만 깨지는 것.

`.gitignore` 로 제외된 파일에 빌드가 의존하거나, 실행 비트가 빠졌거나, 문서가 없는
파일을 안내하는 경우가 여기 해당한다. 로컬에는 그 파일이 이미 있어서 **영원히 재현되지
않는다.**

---

## 실행

```bash
npm run verify:docker                          # 기본 (L0, L2~L6) — 10~25분
npm run verify:docker:full                     # 전체 (L0~L7, bare 포함) — 40~90분
npm run verify:docker -- --layers L0,L3        # 특정 레이어만
npm run verify:docker -- --dirty               # 커밋 전 워킹 트리로 검증
npm run verify:docker -- --ref feature/xxx     # 특정 브랜치/커밋 스냅샷
npm run verify:docker -- --asio-sdk ~/ASIOSDK  # L7(Windows 크로스) 활성화
npm run verify:docker -- --clean               # 이미지/캐시 볼륨 제거
```

첫 실행은 이미지 빌드(emsdk·Rust·cargo install)로 20~40분 걸린다. 이후에는 이미지와
캐시 볼륨을 재사용하므로 훨씬 빠르다.

---

## 검증 레이어

| | 레이어 | 무엇을 보는가 | 이미지 |
|---|---|---|---|
| L0 | 클론 무결성 | tracked 파일만으로 빌드에 착수 가능한가. 실행 비트, 로컬 산출물/키 재료 혼입, 문서-실물 정합 | bare/warm |
| L1 | 세팅 스크립트 | 맨 우분투에서 `setup-wsl.sh` 가 nvm·emsdk 를 실제로 설치하며 완주하는가 | bare |
| L2 | 온보딩 | `bootstrap.sh` 가 **알고리즘 소스 없이도** 안내 후 정상 종료하는가 | bare/warm |
| L3 | 드롭인 빌드 | `custom/` 에 임의의 `.c` 를 넣으면 WASM 이 빌드되고 export 심볼 4개가 유지되는가 | warm |
| L4 | 하드닝 체인 | `FF_PROT_HARDEN=1` 의 Java→wasm-opt→wasm-mutate→obfuscator 가 전부 도는가, 그러고도 계약이 살아남는가 | warm |
| L5 | 정적 번들 | `typecheck`/`lint`/`build:desktop`, 그리고 빌드가 `page.tsx` 를 원복하는가 | warm |
| L6 | Tauri Linux | Rust 셸 컴파일 + `.wasm-seed`/`wasm_key.rs` 자동 생성 + 평문 WASM 제거 | warm |
| L7 | Windows 크로스 | ASIO 헬퍼 mingw 컴파일 + `cargo-xwin` NSIS 패키징 + 사이드카 트리플 일치 | warm |

L1 은 emsdk 를 실제로 내려받아 느리므로 기본 실행에서 빠져 있다. **릴리스 직전
`--full` 로 한 번은 돌릴 것** — warm 이미지에 손으로 적어둔 도구 목록과 실제 setup
스크립트 사이의 드리프트를 잡는 유일한 장치다.

---

## 설계 원칙

**컨테이너에 들어가는 것은 git 이 추적하는 것뿐이다.** `run.sh` 는 `git archive` 로
tracked-only tar 를 떠서 넣는다. 리포 디렉터리를 마운트하거나 `docker build` 컨텍스트에
넣으면 `node_modules`, `public/wasm`, `.wasm-seed` 가 딸려 들어가 정작 잡아야 할
"빠진 파일" 버그를 가려버린다 — 검증이 통째로 무의미해지는 지점이라 여기만은 타협하지
않는다.

**이미지가 두 개인 이유.** `Dockerfile.warm` 에 툴체인을 구워두면 L1(세팅 스크립트
완주)이 무의미해진다. 그래서 아무것도 없는 `Dockerfile.bare` 를 따로 둔다. warm 의 도구
목록은 `scripts/setup/setup-wsl.sh` 와 손으로 동기화되어 있고, 그 드리프트는 L1 이 잡는다.

**한 세션에서 순차 실행.** 레이어마다 컨테이너를 새로 띄우면 `npm ci` 를 예닐곱 번
반복하게 된다. `session.sh` 가 한 컨테이너 안에서 순서대로 돌리고, 어느 레이어가
실패해도 나머지는 계속 간다 — 무엇이 얼마나 깨졌는지 한 번에 봐야 하기 때문이다.

**더미 알고리즘.** 벤더 알고리즘 소스는 우리 손에 없으므로,
`fixtures/custom-algo/dummy_algo.c` 가 계약(export 심볼 4개)만 만족하는 최소 구현으로
대신 선다. 이 fixture 는 **헤더를 include 하지 않는다** — 신규 클론에 `ff_prot.h` 가
없는 실제 상황을 재현해야 하기 때문이다.

---

## Docker 가 덮지 못하는 것

통과했다고 끝이 아니다. 아래는 구조적으로 컨테이너에서 검증할 수 없다.

| 항목 | 이유 | 대안 |
|---|---|---|
| macOS CoreAudio 헬퍼 (`build-mac.sh`, swiftc) | Darwin 호스트 필수 | `MACOS-CHECKLIST.md` 수동 수행 |
| `setup-macos.sh` | 위와 같음 | 위와 같음 |
| 실제 오디오 캡처/재생, V/I 센싱 루프 | 하드웨어(MCHStreamer) 필요 | 실기 검증 |
| GUI 실행, 앱 동작 | 헤드리스 컨테이너 | 실기 검증 |
| `build-wasm.sh` 의 "emcc 없음 → Docker 폴백" | 컨테이너 안에서 DinD 없이는 불가 (warm 이미지엔 emcc 가 있음) | 호스트에서 emcc 를 PATH 에서 빼고 1회 확인 |
| Windows 네이티브 빌드, ASIO 장치 동작 | L7 은 실험적 크로스 경로일 뿐 | 실기 Windows 에서 설치/실행 확인 |
| macOS 서명·notarization·entitlement | Darwin + 인증서 필요 | `MACOS-CHECKLIST.md` |

---

## 새 레이어 추가하기

1. `scenarios/L8-xxx.sh` 를 만들고 `lib/common.sh` 를 source.
2. `check_file` / `check_absent` / `check_exec` / `run_step` / `expect_fail_step` 로
   항목을 기록하고 마지막에 `finish`.
3. `session.sh` 의 `LAYER_SCRIPT` 와 `run.sh` 의 `LAYER_NAME` 에 등록.

시나리오 안에서 `set -e` 를 쓰지 말 것. 첫 실패에서 죽으면 나머지 항목을 못 본다.
