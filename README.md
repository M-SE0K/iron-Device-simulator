# Iron Device Simulator

| Category | Tech Stack |
|:--|:--|
| **UI · Realtime Visualization** | <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js%2015-000000?style=flat-square&logo=nextdotjs&logoColor=white" alt="Next.js 15"></a> <a href="https://react.dev/"><img src="https://img.shields.io/badge/React%2019-61DAFB?style=flat-square&logo=react&logoColor=000000" alt="React 19"></a> <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a> <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind%20CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS"></a> <a href="https://github.com/leeoniya/uPlot"><img src="https://img.shields.io/badge/uPlot-1A1A1A?style=flat-square" alt="uPlot"></a> |
| **Protection Algorithm Engine** | <a href="https://webassembly.org/"><img src="https://img.shields.io/badge/WebAssembly-654FF0?style=flat-square&logo=webassembly&logoColor=white" alt="WebAssembly"></a> <a href="https://en.cppreference.com/w/c"><img src="https://img.shields.io/badge/C-A8B9CC?style=flat-square&logo=c&logoColor=000000" alt="C"></a> |
| **Hardware Audio I/O** | <a href="https://developer.apple.com/documentation/coreaudio"><img src="https://img.shields.io/badge/CoreAudio-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS CoreAudio"></a> <a href="https://www.swift.org/"><img src="https://img.shields.io/badge/Swift-F05138?style=flat-square&logo=swift&logoColor=white" alt="Swift"></a> <a href="https://www.steinberg.net/developers/"><img src="https://img.shields.io/badge/ASIO-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows ASIO"></a> <a href="https://isocpp.org/"><img src="https://img.shields.io/badge/C%2B%2B-00599C?style=flat-square&logo=cplusplus&logoColor=white" alt="C++"></a> |
| **Desktop Shell · Packaging** | <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri%20v2-24C8DB?style=flat-square&logo=tauri&logoColor=000000" alt="Tauri v2"></a> <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust"></a>
| **License** | <a href="LICENSE"><img src="https://img.shields.io/badge/GPL--3.0-A42E2C?style=flat-square&logo=gnu&logoColor=white" alt="License: GPL-3.0"></a> |

<p align="center">
  <strong>English</strong> |
  <a href="README.ko.md">한국어</a>
</p>


A **desktop app** for demonstrating Iron Device Corporation's speaker protection algorithm, developed as part of a Jeonbuk National University SW industry-academic collaboration project.
While an audio file plays, it **captures the speaker's voltage (V) and current (I) sensing signals from real hardware**, runs them through the protection algorithm (compiled to WebAssembly), and visualizes **speaker temperature** and **cone excursion (displacement)** in real time.

The analysis engine runs directly inside the app (the Tauri WebView), and audio playback and capture are handled by a per-platform native helper (macOS CoreAudio / Windows ASIO) in a **single IOProc**, so playback and capture share one clock.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## Prerequisites (Required)

This repository **does not include the protection algorithm C sources or the ASIO SDK.** You must place both at the paths below before builds/packaging will proceed. (Use the SDK shared on Teams.)

```
./iron-Device-simulator
└── native
    ├── wasm-engine/custom/          # ① protection algorithm source drop-in (any filenames)
    │     ├ protection-algorithm.h
    │     └ protection-algorithm.c
    └── windows/audio-device-helper/
          └── third_party/           # ② mkdir third_party
                └── ASIOSDK          # folder name must match (only needed for Windows packaging)
```

---

## Installation

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## Getting Started

One command right after cloning (checks the environment → `npm install` → WASM build → dev server startup check).

```bash
npm run bootstrap
npm run build:tauri -- --windows      # or --mac or --linux
```

## Notes

- **macOS**: after the first launch is blocked, go to System Settings → Privacy & Security → "Open Anyway"
- **Windows**: on the SmartScreen warning, click "More info" → "Run anyway"
- **Linux**: `chmod +x *.AppImage` then run directly — no warning



## Dev Commands

```bash
npm run build:wasm          # compile the C sources in native/wasm-engine to browser-target WASM
npm run build:wasm -- --dev # skip WASM obfuscation (use while working on the algorithm)
npm run build:desktop       # static build → out/ (see the build section above)
npm run build:tauri         # static build + Tauri packaging → out/ + dist-tauri/

npm run build:tauri -- --hostOS --devtools --dev
# --hostOS: {mac, linux, windows}
# --dev: skip WASM obfuscation and encryption (use while working on the algorithm)
# --devtools: enable developer tools

```

## License

Copyright (C) 2026 Iron Device Corporation & JBNU-CILAB.

This project is free and open-source software licensed under the
[GNU General Public License v3.0 only](LICENSE) (`GPL-3.0-only`).
Third-party components remain subject to their respective licenses.
