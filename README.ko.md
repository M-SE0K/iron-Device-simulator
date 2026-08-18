# Iron Device Simulator

| Category | Tech Stack |
|:--|:--|
| **UI · Realtime Visualization** | <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js%2015-000000?style=flat-square&logo=nextdotjs&logoColor=white" alt="Next.js 15"></a> <a href="https://react.dev/"><img src="https://img.shields.io/badge/React%2019-61DAFB?style=flat-square&logo=react&logoColor=000000" alt="React 19"></a> <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a> <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind%20CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS"></a> <a href="https://github.com/leeoniya/uPlot"><img src="https://img.shields.io/badge/uPlot-1A1A1A?style=flat-square" alt="uPlot"></a> |
| **Protection Algorithm Engine** | <a href="https://webassembly.org/"><img src="https://img.shields.io/badge/WebAssembly-654FF0?style=flat-square&logo=webassembly&logoColor=white" alt="WebAssembly"></a> <a href="https://en.cppreference.com/w/c"><img src="https://img.shields.io/badge/C-A8B9CC?style=flat-square&logo=c&logoColor=000000" alt="C"></a> |
| **Hardware Audio I/O** | <a href="https://developer.apple.com/documentation/coreaudio"><img src="https://img.shields.io/badge/CoreAudio-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS CoreAudio"></a> <a href="https://www.swift.org/"><img src="https://img.shields.io/badge/Swift-F05138?style=flat-square&logo=swift&logoColor=white" alt="Swift"></a> <a href="https://www.steinberg.net/developers/"><img src="https://img.shields.io/badge/ASIO-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows ASIO"></a> <a href="https://isocpp.org/"><img src="https://img.shields.io/badge/C%2B%2B-00599C?style=flat-square&logo=cplusplus&logoColor=white" alt="C++"></a> |
| **Desktop Shell · Packaging** | <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri%20v2-24C8DB?style=flat-square&logo=tauri&logoColor=000000" alt="Tauri v2"></a> <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust"></a>
| **License** | <a href="LICENSE"><img src="https://img.shields.io/badge/GPL--3.0-A42E2C?style=flat-square&logo=gnu&logoColor=white" alt="License: GPL-3.0"></a> |

<p align="center">
  <a href="README.md">English</a> |
  <strong>한국어</strong>
</p>


전북대학교 SW 산학협력 프로젝트의 일환으로 개발한, Iron Device Corporation의 스피커 보호 알고리즘을 시연하기 위한 **데스크톱 앱**입니다.
오디오 파일을 재생하는 동안 **실제 하드웨어에서 스피커의 전압(V)·전류(I) 센싱 신호를 캡처**하고, WebAssembly로 컴파일한 보호 알고리즘으로 처리하여 **스피커 온도**와 **진동판 변위(excursion)** 를 실시간으로 시각화합니다.

분석 엔진은 앱의 Tauri WebView 안에서 직접 실행됩니다. 오디오 재생과 캡처는 플랫폼별 네이티브 헬퍼(macOS CoreAudio / Windows ASIO)가 **단일 IOProc**에서 처리하므로 하나의 클록을 공유합니다.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## 사전 준비 사항 (필수)

이 저장소에는 **보호 알고리즘 C 소스와 ASIO SDK가 포함되어 있지 않습니다.** 빌드와 패키징을 진행하기 전에 두 항목을 아래 경로에 배치해야 합니다. Teams에 공유된 SDK를 사용하세요.

```
./iron-Device-simulator
└── native
    ├── wasm-engine/custom/          # ① 보호 알고리즘 소스 배치(파일명 자유)
    │     ├ protection-algorithm.h
    │     └ protection-algorithm.c
    └── windows/audio-device-helper/
          └── third_party/           # ② third_party 디렉터리 생성
                └── ASIOSDK          # 폴더명 일치 필수(Windows 패키징에만 필요)
```

---

## 설치

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## 시작하기

클론 직후 다음 명령을 실행하면 환경 확인 → `npm install` → WASM 빌드 → 개발 서버 기동 확인을 한 번에 수행합니다.

```bash
npm run bootstrap
npm run build:tauri -- --windows      # 또는 --mac / --linux
```

## 참고 사항

- **macOS**: 최초 실행이 차단되면 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"를 선택합니다.
- **Windows**: SmartScreen 경고에서 "추가 정보" → "실행"을 선택합니다.
- **Linux**: `chmod +x *.AppImage`를 실행한 뒤 바로 실행할 수 있으며 별도 경고가 없습니다.



## 개발 명령어

```bash
npm run build:wasm          # native/wasm-engine의 C 소스를 브라우저용 WASM으로 컴파일
npm run build:wasm -- --dev # WASM 난독화 생략(알고리즘 개발 시 사용)
npm run build:desktop       # 정적 빌드 → out/ (위 빌드 절 참고)
npm run build:tauri         # 정적 빌드 + Tauri 패키징 → out/ + dist-tauri/

npm run build:tauri -- --hostOS --devtools --dev
# --hostOS: {mac, linux, windows}
# --dev: WASM 난독화와 암호화 생략(알고리즘 개발 시 사용)
# --devtools: 개발자 도구 활성화

```

## 라이선스

Copyright (C) 2026 Iron Device Corporation & JBNU-CILAB.

이 프로젝트는 [GNU General Public License v3.0 only](LICENSE)
(`GPL-3.0-only`)로 배포되는 자유·오픈소스 소프트웨어입니다.
서드파티 구성요소에는 각 구성요소의 라이선스가 그대로 적용됩니다.
