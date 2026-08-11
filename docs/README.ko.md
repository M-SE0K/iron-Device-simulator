# Iron Device Simulator

| 부문 | 기술 스택 |
|:--|:--|
| **화면 · 실시간 시각화** | <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js%2015-000000?style=flat-square&logo=nextdotjs&logoColor=white" alt="Next.js 15"></a> <a href="https://react.dev/"><img src="https://img.shields.io/badge/React%2019-61DAFB?style=flat-square&logo=react&logoColor=000000" alt="React 19"></a> <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a> <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind%20CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS"></a> <a href="https://github.com/leeoniya/uPlot"><img src="https://img.shields.io/badge/uPlot-1A1A1A?style=flat-square" alt="uPlot"></a> |
| **보호 알고리즘 엔진** | <a href="https://webassembly.org/"><img src="https://img.shields.io/badge/WebAssembly-654FF0?style=flat-square&logo=webassembly&logoColor=white" alt="WebAssembly"></a> <a href="https://emscripten.org/"><img src="https://img.shields.io/badge/Emscripten-6A5E4D?style=flat-square" alt="Emscripten"></a> <a href="https://en.cppreference.com/w/c"><img src="https://img.shields.io/badge/C-A8B9CC?style=flat-square&logo=c&logoColor=000000" alt="C"></a> |
| **하드웨어 오디오 I/O** | <a href="https://developer.apple.com/documentation/coreaudio"><img src="https://img.shields.io/badge/CoreAudio-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS CoreAudio"></a> <a href="https://www.swift.org/"><img src="https://img.shields.io/badge/Swift-F05138?style=flat-square&logo=swift&logoColor=white" alt="Swift"></a> <a href="https://www.steinberg.net/developers/"><img src="https://img.shields.io/badge/ASIO-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows ASIO"></a> <a href="https://isocpp.org/"><img src="https://img.shields.io/badge/C%2B%2B-00599C?style=flat-square&logo=cplusplus&logoColor=white" alt="C++"></a> |
| **데스크톱 셸 · 패키징** | <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri%20v2-24C8DB?style=flat-square&logo=tauri&logoColor=000000" alt="Tauri v2"></a> <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust"></a>|
| **라이선스** | <a href="LICENSE"><img src="https://img.shields.io/badge/GPL--3.0-A42E2C?style=flat-square&logo=gnu&logoColor=white" alt="License: GPL-3.0"></a> |
<p align="center">
  <a href="../README.md"><strong>English</strong></a> |
  <a href="docs/README.ko.md"><strong>한국어</strong></a> |
</p>


전북대학교 SW 산학협력 프로젝트로 개발된, Iron Device Corporation의 스피커 보호 알고리즘을 시연하기 위한 **데스크톱 앱**입니다.
오디오 파일을 재생하면서 스피커의 **전압(V)·전류(I) 센싱 신호를 실제 하드웨어에서 캡처**하고, 이를 보호 알고리즘(WebAssembly로 컴파일)에 통과시켜 **스피커 온도**와 **진동판 변위(excursion)** 를 실시간으로 시각화합니다.

분석 엔진은 앱(Tauri WebView) 안에서 그대로 돌고, 오디오 재생과 캡처는 플랫폼별 네이티브 헬퍼(macOS CoreAudio / Windows ASIO)가 **하나의 IOProc**으로 처리해 재생과 캡처가 같은 클록을 공유합니다.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## 사전 준비 (필수)

이 저장소에는 **보호 알고리즘 C 소스와 ASIO SDK가 들어 있지 않습니다.** 두 가지를 아래 경로에 직접 배치해야 빌드/패키징이 진행됩니다.
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

---

## 설치

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## 시작

클론 직후 원커맨드(환경 확인 → `npm install` → WASM 빌드 → dev 서버 기동 확인)

```bash
npm run bootstrap
npm run build:tauri -- --windows      # or --mac or --linux
```

## 주의사항
- **macOS**: 최초 실행이 차단된 뒤 시스템 설정 → 개인정보 보호 및 보안 → ‘그래도 열기’ 승인
- **Windows**: SmartScreen 경고에서 "추가 정보" → "실행" 클릭
- **Linux**: `chmod +x *.AppImage` 후 바로 실행 — 별도 경고 없음



## 개발 명령어

```bash
npm run build:wasm          # native/wasm-engine의 C 소스를 브라우저 타깃 WASM으로 컴파일
npm run build:wasm -- --dev # Wasm 난독화 미수행(알고리즘 개발 작업시 수행)
npm run build:desktop       # 정적 빌드 → out/ (위 빌드 항목 참고)
npm run build:tauri         # 정적 빌드 + Tauri 패키징 → out/ + dist-tauri/

npm run build:tauri -- --hostOS --devtools --dev
# --hostOS: {mac, linux, windows}
# --dev: Wasm 난독화 및 암호화 미수행(알고리즘 개발 작업시 수행)
# --devtools: 개발자 도구 활성화

```

## 라이선스

Copyright (C) 2026 Iron Device Corporation & JBNU-CILAB.

이 프로젝트는 [GNU General Public License v3.0 only](LICENSE)
(`GPL-3.0-only`)로 배포되는 자유·오픈소스 소프트웨어입니다.
서드파티 구성요소에는 각 구성요소의 라이선스가 그대로 적용됩니다.
