# Iron Device Simulator

[English](README.md) | 한국어

전북대학교 SW 산학협력 프로젝트로 개발된, Iron Device Corporation의 스피커 보호 알고리즘 라이브러리(`libirontune.so`)를 시연하기 위한 웹 기반 대시보드입니다.
오디오 파일 업로드 또는 실시간 마이크 입력으로 **스피커 온도**와 **진동판 변위(excursion)**를 실시간으로 시각화합니다. 

**Teams에 공유된 SDK를 아래의 경로로 옮긴 뒤 진행해야 되며, third_party를 반드시 추가해야 패키징이 진행됩니다.**
```
./iron-Device-simulator
ㄴ--native
        ㅏ----wasm-engine/custom
        |                    ㅏ 보호 알고리즘.h
        |                    ㄴ 보호 알고리즘.c
        ㄴ----windows
            ㄴ----third_party  # mkdir third_party 
                ㄴ---- ASIOSDK # 폴더명 일치
```

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## 설치

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## 빠른 시작

클론 직후 원커맨드(환경 확인 → `npm install` → WASM 빌드 → dev 서버)
이후 로컬 서버를 종료해주세요. ```Ctrl + c```

```bash
npm run bootstrap
```

### 데스크톱 앱 패키징

정적 코어(`out/`, 브라우저 WASM 엔진)와 네이티브 오디오 헬퍼(`native/`)를 Tauri v2 번들러로 감싸 `scripts/build/build-tauri.sh`가 `dist-tauri/{mac,windows,linux}/` 아래에 산출물을 생성합니다. (이 프로젝트는 과거 Electron 패키지도 Tauri와 병행해 배포했으나, 그 셸은 이후 완전히 제거되고 Tauri 단일 체제가 됐습니다.)

```bash
npm run build:tauri             # 옵션 없이 실행하면 현재 호스트 OS 타깃만 빌드(아래 제약 참고)
npm run build:tauri:mac         # mac 전용 (macOS에서 실행해야 함)
npm run build:tauri:windows     # windows 전용 (Windows에서 실행해야 함)
npm run build:tauri:linux       # linux 전용 (Linux에서 실행해야 함)
npm run tauri:preview           # npx tauri dev — 현재 out/ 기준 실행, 패키징 없음
```

**추가 사전 요구사항**: Rust 툴체인(`cargo`, [rustup.rs](https://rustup.rs)) 및 Linux/WSL에서는 `libwebkit2gtk-4.1-dev pkg-config libssl-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev`. `npm run bootstrap` / `scripts/setup/setup-*.sh`가 이를 확인해 없으면 안내만 합니다(비차단).

**중요한 제약 — 호스트 OS = 타깃 OS (실험적 예외 하나 있음)**: electron-builder(이 프로젝트가 예전에 쓰던, 지금은 제거된 Electron 셸의 패키징 도구)와 달리 Tauri는 호스트 OS와 타깃 OS가 같아야 합니다(mac 산출물은 macOS에서, Linux 산출물은 Linux에서). 그래서 `build:tauri`는 옵션 없이 실행해도 현재 머신의 타깃 하나만 자동으로 빌드하고, `build:tauri:mac`/`build:tauri:linux`를 맞지 않는 호스트에서 실행하면 조용히 아무것도 안 하는 대신 명확한 에러로 안내합니다.

`build:tauri:windows`만은 예외입니다: 네이티브 Windows 호스트에서는 그대로 빌드되지만, **WSL/Linux에서 실행해도 이제 동작합니다** — Tauri의 [실험적(experimental) 크로스 컴파일 경로](https://v2.tauri.app/distribute/windows-installer/)(`cargo-xwin` + NSIS)를 통해서입니다. 이 리포의 `scripts/build/build-tauri.sh`가 Linux 호스트를 자동 감지해 별도 플래그 없이 이 경로로 전환합니다. Windows 머신 없이도 반복 작업을 할 수 있게 해주는 편의 기능이며, 상류(Tauri)에서 실험적이라고 명시한 경로이므로 **실기 Windows 빌드를 여전히 정본/폴백 경로로 취급**하고 배포 전에는 실기 Windows에서 설치/실행을 다시 검증해야 합니다. 크로스 경로의 추가 사전 요구사항(위 Rust 툴체인에 더해):

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
sudo apt install nsis clang lld llvm    # makensis + cargo-xwin이 필요로 하는 링커/코드젠 도구
```

첫 크로스 빌드는 MS CRT/SDK를 `~/.cache`에 내려받습니다(네트워크 필요, 수 분 소요) — 이후 빌드는 캐시를 재사용합니다.

macOS 빌드는 Apple Silicon이 브라우저에서 받은 앱을 “손상됨”으로 잘못
판정하지 않도록 앱 전체에 **ad-hoc 서명**을 적용합니다. 다만 Developer ID 공증
빌드는 아니며 팀 내부 배포용입니다. 최초 실행 시 다음 한 단계가 필요합니다.

- **macOS**: 최초 실행이 차단된 뒤 시스템 설정 → 개인정보 보호 및 보안 → ‘그래도 열기’ 승인
- **Windows**: SmartScreen 경고에서 "추가 정보" → "실행" 클릭
- **Linux**: `chmod +x *.AppImage` 후 바로 실행 — 별도 경고 없음

### 알려진 제약

- **E2E 지연 측정은 macOS에서 자동화된 원격 디버깅 경로가 없습니다.** `scripts/실험용/measure-e2e-latency.sh` 등은 Windows에서는 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`로 Chrome DevTools Protocol(CDP) 원격 디버깅을 열 수 있지만, macOS의 WKWebView는 CDP를 지원하지 않아 대응하는 자동화 경로가 없습니다(Safari Web Inspector 콘솔로 수동 측정은 가능 — `docs/e2e-latency-experiment.md` 참고).
- **Tauri 크로스 패키징은 완전 불가는 아니지만 제한적입니다.** Windows 산출물은 위에서 설명한 실험적 `cargo-xwin` 경로로 WSL/Linux에서도 크로스 빌드할 수 있습니다 — 다만 최종 검증은 실기 Windows에서 한 번 더 하는 것을 전제로 합니다. macOS는 여전히 실제 Mac이 있어야 합니다(이 리포에는 크로스 경로가 없고 계획도 없습니다). Linux 산출물도 여전히 Linux 호스트가 있어야 합니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `USE_QUEUE` | `true` | `false`로 설정하면 출력 큐 스케줄러 대신 단순 FIFO 렌더 경로를 사용합니다.  |
| `USE_WORKER_ENGINE` | `1` | `0` 로 1로 설정하여 메인 스레드의 작업을 분산시켜 온전히 UI 렌더링 작업만 진행할 수 있게합니다. |


## 개발 명령어

웹에서의 동작은 배제하고 작성된 명령어로, Tauri 개발 명령어이니 참고 부탁드립니다.

```bash
npm run wasm:build          # native/wasm-engine/*.c를 브라우저 타깃 WASM으로 컴파일
npm run wasm:preview        # 알고리즘만 변경됐을 때 WASM만 다시 빌드하고 Tauri 미리보기를 재실행
npm run build:desktop       # 정적 빌드 → out/ (위 빌드 항목 참고)
npm run build:tauri         # {:mac, :windows, :linux} 정적 빌드 + Tauri 패키징 → out/ + dist-tauri/ (위 빌드 항목 참고)
npm run tauri:preview       # npx tauri dev — 현재 out/ 기준 실행, 패키징 없음. 앱 환경에서의 빠른 확인 가능(개발할 때 주로 사용하시면 됩니다.)
```

## 기술 스택

| 분류 | 기술 |
|---|---|
| 프레임워크 | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| 차트 | Apache ECharts (echarts-for-react) |
| 파형 | wavesurfer.js |
| 분석 엔진 | Emscripten(`emcc`) — `native/wasm-engine/ff_prot.c` → WebAssembly, 브라우저 타깃, 프로세스 내부 실행(서버 없음) |
| 데스크톱 패키징 | Tauri v2 (Rust) — macOS / Windows / Linux, 산출물은 `dist-tauri/` 아래 |


## 라이선스

Copyright (C) 2026 Iron Device Corporation and JBNU-CILAB.

이 프로젝트는 [GNU General Public License v3.0 only](LICENSE)
(`GPL-3.0-only`)로 배포되는 자유·오픈소스 소프트웨어입니다.
서드파티 구성요소에는 각 구성요소의 라이선스가 그대로 적용됩니다.
