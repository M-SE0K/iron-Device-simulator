# Iron Device Simulator

[English](README.md) | 한국어

전북대학교 SW 산학협력 프로젝트로 개발된, Iron Device Corporation의 스피커 보호 알고리즘을 시연하기 위한 **데스크톱 앱**입니다.
오디오 파일을 재생하면서 스피커의 **전압(V)·전류(I) 센싱 신호를 실제 하드웨어에서 캡처**하고, 이를 보호 알고리즘(WebAssembly로 컴파일)에 통과시켜 **스피커 온도**와 **진동판 변위(excursion)** 를 실시간으로 시각화합니다.

서버·DB·로그인이 없는 완전한 **server-less** 구조입니다. 분석 엔진은 앱(Tauri WebView) 안에서 그대로 돌고, 오디오 재생과 캡처는 플랫폼별 네이티브 헬퍼(macOS CoreAudio / Windows ASIO)가 **하나의 IOProc**으로 처리해 재생과 캡처가 같은 클록을 공유합니다.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## 사전 준비 (필수)

이 저장소에는 **보호 알고리즘 C 소스와 ASIO SDK가 들어 있지 않습니다.** 두 가지를 아래 경로에 직접 배치해야 빌드/패키징이 진행됩니다. (Teams에 공유된 SDK를 사용하세요.)

```
./iron-Device-simulator
└── native
    ├── wasm-engine/custom/          # ① 보호 알고리즘 소스 드롭인 (파일명 자유)
    │     ├ protection-algorithm.h
    │     └ protection-algorithm.c
    └── windows/audio-device-helper/
          └── third_party/           # ② mkdir third_party
                └── ASIOSDK          # 폴더명 일치 (Windows 패키징 시에만 필요)
```

**① 알고리즘 소스** — `native/wasm-engine/custom/`에 `.c`/`.h`를 넣으면 `build-wasm.sh`가 상위 폴더의 참조 스텁 대신 이 폴더의 소스만 컴파일합니다. 파일명은 자유지만 `ff_prot_init` / `ff_prot_set_param` / `ff_prot_start_exec`(9인자) / `ff_prot_stop_exec` **네 개의 export 심볼**은 고정입니다 — JS 쪽에서 이 이름을 직접 호출하기 때문입니다. 기존 알고리즘의 함수명이 다르면 위임 래퍼 하나만 추가하면 됩니다. 자세한 계약은 `native/wasm-engine/custom/README.md` 참고.

**② ASIO SDK** — Windows 네이티브 오디오 헬퍼(ASIO) 컴파일에만 필요합니다. 재배포 제약이 있어 저장소에 포함하지 않으며, `ASIOSDK_DIR=<경로>`로 다른 위치를 지정할 수도 있습니다. macOS/Linux 타깃만 빌드한다면 없어도 됩니다.

---

## 설치

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## 빠른 시작

클론 직후 원커맨드(환경 확인 → `npm install` → WASM 빌드 → dev 서버 기동 확인)

```bash
npm run bootstrap
npm run build:tauri -- --mac      # 또는 --windows / --linux
```

dev 서버는 **실제 HTTP 응답까지 확인한 뒤 자동으로 종료**되므로 `Ctrl + C`를 누를 필요가 없습니다. 서버를 띄우지 않고 준비만 하려면 `BOOTSTRAP_NO_DEV=1`, 느린 머신에서 기동 대기를 늘리려면 `BOOTSTRAP_DEV_TIMEOUT=180`을 앞에 붙이세요.

알고리즘 소스가 아직 없어도 이 스크립트는 실패하지 않습니다 — `npm install`까지만 마치고 엔진 빌드를 건너뛴 뒤, 무엇을 어디에 넣어야 하는지 안내하고 종료합니다.

마지막에는 Rust 툴체인·WebKitGTK(Linux)·Xcode CLT(macOS)·Java·ASIO SDK 등 **데스크톱 패키징에 결국 필요해지는 전제조건을 점검해, 실제로 빠진 것만** 설치 명령과 함께 모아서 보여줍니다.

> ⚠️ `npm run dev`로 뜨는 브라우저 탭은 **UI 확인 전용**입니다. 장치 제어·하드웨어 캡처·파일 재생은 Tauri 네이티브 브리지(`window.audioDevice` 등)를 통해서만 동작하므로, 실제 동작 확인은 `npm run tauri:preview` 또는 패키징된 앱에서 해야 합니다.

### 데스크톱 앱 패키징

정적 코어(`out/`, 브라우저 WASM 엔진)와 네이티브 오디오 헬퍼(`native/`)를 Tauri v2 번들러로 감싸 `scripts/build/build-tauri.sh`가 `dist-tauri/{mac,windows,linux}/` 아래에 산출물을 생성합니다.

```bash
npm run build:tauri               # 옵션 없이 실행하면 현재 호스트 OS 타깃만 빌드(아래 제약 참고)
npm run build:tauri -- --mac      # mac 전용 (macOS에서 실행해야 함)
npm run build:tauri -- --windows  # windows 전용 (Windows 또는 WSL/Linux 크로스)
npm run build:tauri -- --linux    # linux 전용 (Linux에서 실행해야 함, 네이티브 헬퍼 없음)
npm run tauri:preview             # npx tauri dev — 현재 out/ 기준 실행, 패키징 없음
```

**추가 사전 요구사항**: Rust 툴체인(`cargo`, [rustup.rs](https://rustup.rs)) 및 Linux/WSL에서는 `libwebkit2gtk-4.1-dev pkg-config libssl-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev`. `npm run bootstrap` / `scripts/setup/setup-*.sh`가 이를 확인해 없으면 안내만 합니다(비차단).

**중요한 제약 — 호스트 OS = 타깃 OS (실험적 예외 하나 있음)**: tauri는 호스트 OS와 타깃 OS가 같아야 합니다(mac 산출물은 macOS에서, Linux 산출물은 Linux에서). 그래서 `build:tauri`는 옵션 없이 실행해도 현재 머신의 타깃 하나만 자동으로 빌드하고, `--mac`/`--linux`를 맞지 않는 호스트에서 실행하면 조용히 아무것도 안 하는 대신 명확한 에러로 안내합니다.

`--windows`만은 예외입니다: 네이티브 Windows 호스트에서는 그대로 빌드되지만, **WSL/Linux에서 실행해도 동작합니다** — Tauri의 [실험적(experimental) 크로스 컴파일 경로](https://v2.tauri.app/distribute/windows-installer/)(`cargo-xwin` + NSIS)를 통해서입니다. `scripts/build/build-tauri.sh`가 Linux 호스트를 자동 감지해 별도 플래그 없이 이 경로로 전환합니다. Windows 머신 없이도 반복 작업을 할 수 있게 해주는 편의 기능이며, 상류(Tauri)에서 실험적이라고 명시한 경로이므로 **실기 Windows 빌드를 여전히 정본/폴백 경로로 취급**하고 배포 전에는 실기 Windows에서 설치/실행을 다시 검증해야 합니다. 크로스 경로의 추가 사전 요구사항(위 Rust 툴체인에 더해):

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
sudo apt install nsis clang lld llvm    # makensis + cargo-xwin이 필요로 하는 링커/코드젠 도구
```

위 항목은 대부분 직접 준비할 필요가 없습니다 — `build-tauri.sh`가 **패키징을 시작하기 전에** 툴체인을 먼저 점검하고, sudo가 필요 없는 rustup/cargo 계열(기본 툴체인 `rustup install stable`, Windows 타깃 추가, `cargo install cargo-xwin`)은 자동으로 설치합니다. 정적 빌드와 ASIO 헬퍼 컴파일에 몇 분을 쓴 뒤 마지막 단계에서 툴체인 부재로 실패하던 문제를 없애기 위한 것입니다. 자동 설치를 원하지 않으면 `TAURI_NO_AUTO_INSTALL=1`을 지정하세요 — 그러면 필요한 명령만 안내하고 즉시 중단합니다. sudo가 필요한 apt 패키지(`clang lld llvm`, `nsis`)는 자동 설치하지 않고 경고만 남긴 뒤 진행합니다.

첫 크로스 빌드는 MS CRT/SDK를 `~/.cache`에 내려받습니다(네트워크 필요, 수 분 소요) — 이후 빌드는 캐시를 재사용합니다.

Windows 헬퍼(ASIO)의 크로스 컴파일이 실패하면 **빌드 전체가 실패합니다** — 커밋된 낡은 `.exe`를 모르는 채 패키징하는 사고를 막기 위한 의도적 동작입니다. 툴체인이 없는 환경에서 기존 `.exe`를 그대로 쓰려면 `SKIP_WIN_HELPER_BUILD=1`을 지정하세요.

macOS 빌드는 Apple Silicon이 브라우저에서 받은 앱을 “손상됨”으로 잘못
판정하지 않도록 앱 전체에 **ad-hoc 서명**을 적용합니다. 다만 Developer ID 공증
빌드는 아니며 팀 내부 배포용입니다. 최초 실행 시 다음 한 단계가 필요합니다.

- **macOS**: 최초 실행이 차단된 뒤 시스템 설정 → 개인정보 보호 및 보안 → ‘그래도 열기’ 승인
- **Windows**: SmartScreen 경고에서 "추가 정보" → "실행" 클릭
- **Linux**: `chmod +x *.AppImage` 후 바로 실행 — 별도 경고 없음

### DevTools 차단과 측정 전용 빌드

배포 빌드에는 **개발자 도구가 아예 컴파일되지 않습니다.** `devtools` cargo 피처가 기본 off라 WebView 인스펙터 자체가 빠지고(`isInspectable`/`AreDevToolsEnabled` 강제 false), 원격 디버깅 인자(`--remote-debugging*`)나 관련 환경 변수는 실행 시점에 차단·제거되며, 단축키(F12·Cmd+Opt+I·Ctrl+Shift+I/J/C·Ctrl+U)와 컨텍스트 메뉴도 막힙니다. 자세한 내용은 `docs/devtools-hardening-plan.md`를 보세요.

콘솔이 필요한 작업은 `--devtools`를 붙여 **측정 전용 빌드**를 따로 만들어야 합니다. 배포용으로는 쓰지 마세요.

```bash
npm run build:tauri -- --mac --devtools
```

### 엔진 보호 (난독화 · 암호화 배포)

정품 알고리즘을 넣은 뒤에는, 패키지 안에 평문 `.wasm`이 남아 파일 탐색기로 바로 꺼내지는 상황을 막는 경로가 준비돼 있습니다. 서버가 없어 복호화 재료가 결국 앱 바이너리에 들어가야 하므로, 이건 암호학적 기밀성이 아니라 **리버싱 비용을 올리는 방어층**입니다.

- **빌드 하드닝·난독화** — `FF_PROT_HARDEN=1 npm run build:wasm`로 빌드하면 Emscripten 하드닝 플래그(`-flto -g0 --closure 1`) → `wasm-opt` 스트립 → `wasm-mutate` 구조 변형 → 상수 XOR 난독화 → 글루 JS 난독화가 순서대로 적용됩니다. 구조 변형 단계만 `cargo install wasm-tools`가 필요하고, 없으면 비파괴적으로 건너뜁니다. 조정 노브는 `native/wasm-engine/custom/README.md` 참고.
- **암호화 배포** — 패키징 시 `scripts/build/wasm-encryption/stage-encrypted-wasm.sh`가 `.wasm`을 AES-256-GCM으로 암호화해 `src-tauri/resources/ff_prot.wasm.enc`로 동봉하고, `out/`의 평문 사본은 지웁니다. 복호화 키는 바이너리에 상수로 박히지 않고 seed 재료(`.wasm-seed`, 머신당 1회 생성·git 제외)에서 **HKDF-SHA256으로 런타임 파생**되며, GCM AAD로 배포 문맥에 묶여 있습니다. 전체 흐름은 `docs/wasm-encryption.md`에 정리돼 있습니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `USE_QUEUE` | `true` | `false`로 설정하면 출력 큐 스케줄러 대신 단순 FIFO 렌더 경로를 사용합니다. |
| `USE_WORKER_ENGINE` | `1` | 기본값에서는 분석 엔진이 Web Worker에서 돌아 메인 스레드는 UI 렌더링만 담당합니다. `0`으로 두면 메인 스레드에서 직접 실행합니다(워커 생성이 실패해도 같은 경로로 폴백). |

빌드 시점에만 쓰는 변수도 있습니다.

| 변수 | 설명 |
|---|---|
| `FF_PROT_HARDEN` | `1`이면 WASM 난독화·하드닝 파이프라인을 켭니다(위 "엔진 보호" 참고). |
| `SKIP_WIN_HELPER_BUILD` | `1`이면 Windows ASIO 헬퍼 재컴파일을 건너뛰고 커밋된 `.exe`를 씁니다. |
| `ASIOSDK_DIR` | ASIO SDK 위치를 기본 경로 대신 직접 지정합니다. |
| `TAURI_NO_AUTO_INSTALL` | `1`이면 Windows 크로스 빌드의 툴체인 자동 설치를 끄고, 필요한 명령만 안내한 뒤 중단합니다. |
| `BOOTSTRAP_NO_DEV` | `1`이면 `npm run bootstrap`이 dev 서버 기동 확인을 건너뜁니다. |
| `BOOTSTRAP_DEV_TIMEOUT` | `npm run bootstrap`의 dev 서버 기동 대기 시간(초, 기본 `90`). |

## 개발 명령어

웹에서의 동작은 배제하고 작성된 명령어로, Tauri 개발 명령어이니 참고 부탁드립니다.

```bash
npm run build:wasm          # native/wasm-engine의 C 소스를 브라우저 타깃 WASM으로 컴파일
                            #   (emcc가 없으면 Docker 이미지로 자동 폴백)
npm run build:desktop       # 정적 빌드 → out/ (위 빌드 항목 참고)
npm run build:tauri         # 정적 빌드 + Tauri 패키징 → out/ + dist-tauri/ (-- --mac/--windows/--linux 추가 가능)
npm run tauri:preview       # npx tauri dev — 현재 out/ 기준 실행, 패키징 없음.
```

## 기술 스택

| 분류 | 기술 |
|---|---|
| 프레임워크 | Next.js 15 (App Router, 정적 export) |
| UI | React 19 · Tailwind CSS |
| 차트 | µPlot (uplot) — 실시간 스트리밍 렌더 |
| 분석 엔진 | Emscripten(`emcc`)로 컴파일한 WebAssembly — 기본은 Web Worker, 폴백은 메인 스레드(서버 없음) |
| 네이티브 오디오 | macOS CoreAudio(Swift) / Windows ASIO(C++, mingw 크로스) 헬퍼 — 재생·캡처 단일 IOProc |
| 데스크톱 패키징 | Tauri v2 (Rust) — macOS / Windows / Linux, 산출물은 `dist-tauri/` 아래 |

## 라이선스

Copyright (C) 2026 Iron Device Corporation and JBNU-CILAB.

이 프로젝트는 [GNU General Public License v3.0 only](LICENSE)
(`GPL-3.0-only`)로 배포되는 자유·오픈소스 소프트웨어입니다.
서드파티 구성요소에는 각 구성요소의 라이선스가 그대로 적용됩니다.
