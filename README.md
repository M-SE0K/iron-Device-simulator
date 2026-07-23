# Iron Device Simulator

English | [한국어](README.ko.md)

A web-based dashboard for demonstrating Iron Device Corporation's speaker protection algorithm library (`libirontune.so`), developed as part of a Jeonbuk National University SW industry-academic collaboration project.
Visualizes **speaker temperature** and **cone excursion (displacement)** in real time from an uploaded audio file or live microphone input.

**Move the SDK shared on Teams to the path below before proceeding — packaging will not work unless `third_party` is added.**
```
./iron-Device-simulator
└──electron
        ├────wasm-engine/custom
        │                    ├ protection-algorithm.h
        │                    └ protection-algorithm.c
        └────windows
            └────third_party  # mkdir third_party
                └──── ASIOSDK # folder name must match exactly
```

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## Installation

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## Quick Start

One command right after cloning (checks the environment → `npm install` → WASM build → dev server).
Afterwards, stop the local server with ```Ctrl + c```

```bash
npm run bootstrap
```

### Desktop App Packaging (Electron)

Runs the same static core build as `build:desktop`, then wraps it with [electron-builder](https://www.electron.build/) to produce 6 installable desktop apps for **macOS, Windows, and Linux** (both `x64` and `arm64`) under `dist-electron/`.
```bash
npm run build:electron          # package all OS targets

npm run build:electron:linux    # linux only (improvements planned)
npm run build:electorn:mac      # mac only
npm run build:electron:windows  # windows only
```

**These builds are unsigned** (intended for internal team distribution, not app-store/public release — see `electron-builder.yml`). First launch requires one manual step:

- **macOS**: right-click the app → Open (Gatekeeper blocks unsigned apps opened by double-click)
- **Windows**: click "More info" → "Run anyway" on the SmartScreen warning
- **Linux**: `chmod +x *.AppImage` then run directly — no warning

To preview without a full package build (once `out/` already exists from any static build):


```bash
npm run build:desktop       # build
npm run electron:preview    # electron . — runs electron/main.js against the current out/
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `USE_QUEUE` | `true` | Set to `false` to use the plain FIFO render path instead of the output-queue scheduler.  |
| `USE_WORKER_ENGINE` | `1` | Set from `0` to `1` to offload the main thread's work, so it can proceed with UI rendering only. |


## Dev Commands

These commands are written excluding web behavior — they're Electron dev commands, so please use them with that in mind.

```bash
npm run wasm:build          # compile electron/native/wasm-engine/*.c to browser-target WASM (emcc, falls back to Docker if missing)
npm run build:desktop       # static build → out/ (see the build section above)
npm run build:electron      # {:linux, :mac, :windows} static build + Electron packaging → out/ + dist-electron/ (see the build section above)
npm run electron:preview    # electron . — runs electron/main.js against the current out/, no packaging. Quick way to check the app environment (mainly for use during development).
```

## Tech Stack

| Category | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| Charts | Apache ECharts (echarts-for-react) |
| Waveform | wavesurfer.js |
| Analysis Engine | Emscripten (`emcc`) — `electron/native/wasm-engine/ff_prot.c` → WebAssembly, browser target, run in-process (no server) |
| Desktop Packaging | Electron + electron-builder (macOS / Windows / Linux) |


## License

Jeonbuk National University SW Industry-Academic Collaboration Project — Redistribution and public disclosure prohibited.
