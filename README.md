# Iron Device Simulator

English | [한국어](README.ko.md)

A web-based dashboard for demonstrating Iron Device Corporation's speaker protection algorithm library (`libirontune.so`), developed as part of a Jeonbuk National University SW industry-academic collaboration project.

Visualizes **speaker temperature** and **excursion displacement** in real-time via audio file upload or live microphone input.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## Requirements

- Node.js 20+
- npm 9+
- [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) (`emcc`) — to build the WASM engine (`npm run wasm:build`). **Not required if you have Docker**: `build-wasm.sh` automatically falls back to the official `emscripten/emsdk` image when `emcc` is missing.
- Electron packaging only: `electron` / `electron-builder` are already devDependencies — no separate install needed. Cross-compiling a Windows NSIS installer from macOS/Linux would require Wine, which is why the Windows target here is a signing/Wine-free portable `.zip` instead (see [Desktop App Packaging (Electron)](#desktop-app-packaging-electron)).

---

## Installation

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## Running Locally

One command right after cloning (checks the environment → `npm install` → WASM build → dev server):

```bash
npm run bootstrap     # → http://localhost:3000
```

Or step by step:

```bash
npm run wasm:build   # once — compiles electron/native/wasm-engine/*.c → public/wasm/ff_prot.{js,wasm} (emcc, or Docker fallback)
npm run dev           # next dev — http://localhost:3000
```

---

## Bring Your Own Algorithm

The bundled analysis engine (`electron/native/wasm-engine/ff_prot.c`) is a **reference stub** — the folder is designed so you can drop in your own C implementation and run the app against it:

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
# drop your .c/.h files into electron/native/wasm-engine/custom/ — ANY file names
#   (when custom/ has sources, the build automatically compiles those INSTEAD of
#    the stub — no need to delete or overwrite anything, so upstream stub updates
#    never conflict with your code)
npm run bootstrap     # → http://localhost:3000, charts now driven by YOUR algorithm
```

The only contract is the four `ff_prot_*` functions declared in `electron/native/wasm-engine/ff_prot.h` (`init` / `set_param` / `start_exec` — 9 args / `stop_exec`); if your function names differ, add a thin wrapper `.c` that delegates to them (example in `electron/native/wasm-engine/custom/README.md`). See `electron/native/wasm-engine/README.md` § "내 알고리즘 넣기" for the full drop-in guide (buffer conventions, exported-function list, debug builds).

---

## Building

### Web (any static host)

```bash
npm run build:desktop   # → out/ (compiles WASM + next build --output export)
npx serve out            # serve the static bundle locally
```

Open the URL `serve` prints (defaults to http://localhost:3000). `out/` is a plain static site — deploy it to any static host (Vercel, Cloudflare Pages, Netlify, GitHub Pages, S3, Nginx, etc.) the same way.

> Opening `out/index.html` directly via `file://` will **not** work — asset paths are absolute (`/_next/...`), so it must be served from a web root.

### Desktop App Packaging (Electron)

```bash
npm run build:electron   # → out/ (WASM + static export) + dist-electron/ (packaged apps)
```

This runs the same static core build as `build:desktop`, then wraps it with [electron-builder](https://www.electron.build/) into installable desktop apps for **macOS, Windows, and Linux** (both `x64` and `arm64`), producing 6 artifacts under `dist-electron/`:

| Platform | Artifacts |
|---|---|
| macOS | `.dmg`, `.zip` (x64 + arm64) |
| Windows | `.zip` portable (x64 + arm64) |
| Linux | `.AppImage` (x64 + arm64) |

`electron/main.js` starts a small local HTTP server bound to `127.0.0.1` and serves `out/` to a `BrowserWindow` — a plain `file://` load doesn't work for the same absolute-asset-path reason as the web build above. No backend, no `ws://` connection; the WASM engine still runs entirely in-process inside the Electron renderer, same as the web build.

**These builds are unsigned** (intended for internal team distribution, not app-store/public release — see `electron-builder.yml`). First launch requires one manual step:

- **macOS**: right-click the app → Open (Gatekeeper blocks unsigned apps opened by double-click)
- **Windows**: click "More info" → "Run anyway" on the SmartScreen warning
- **Linux**: `chmod +x *.AppImage` then run directly — no warning

To preview without a full package build (after `out/` already exists from any static build):

```bash
npm run electron:preview   # electron . — launches electron/main.js against the current out/
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `USE_QUEUE` | `true` | Set to `false` to use the plain FIFO render path instead of the output-queue scheduler. Read server-side at render time (`next build && next start`), not honored in a static export build. |

---

## Dev Commands

```bash
npm run dev          # next dev — HMR-enabled dev server (WASM engine always active)
npm run build        # Next.js production build
npm start            # Production server (next start)
npm run lint         # ESLint

npm run bootstrap     # one-shot right after cloning: env check → npm install → wasm:build → dev server
npm run wasm:build    # Compile electron/native/wasm-engine/*.c to browser-target WASM (emcc, or Docker fallback)
npm run build:desktop # Static web build → out/ (see Building above)
npm run build:electron # Static build + Electron packaging → out/ + dist-electron/ (see Building above)
npm run electron:preview # electron . — launch electron/main.js against the current out/, no packaging
```

Manual profiling: play a session in the app, then run `window.__ironPerf.summary()` / `.download()` in the browser console.

### Latency Measurement (experimental, `scripts/실험용/`)

Manual profiling tools outside the normal dev/build loop — see [docs/e2e-latency-experiment.md](docs/e2e-latency-experiment.md) for the full N1~N12 pipeline harness guide.

```bash
npm run e2e:measure                  # opens a dev server tab with ?e2e=1, enabling the N1~N12 latency harness
npm run e2e:summarize -- report.json # summarizes a window.__ironE2E.download() JSON report
npm run loopback:measure -- --ref impulse.wav --capture vi-capture.wav
                                      # offline round-trip (H/W loopback) latency from a played impulse + its captured V/I WAV
```

### WASM Build (`electron/native/wasm-engine/`)

> This folder lives under `electron/` but isn't Electron-specific — its output
> (`public/wasm/ff_prot.{js,wasm}`) is used by the plain web build too.

```bash
cd electron/native/wasm-engine
./build-wasm.sh       # → ../../../public/wasm/ff_prot.{js,wasm} (Emscripten, browser target — falls back to Docker if emcc is missing)
make selftest         # pure-C self-test of the reference model (temperature rise + L/R excursion diff), unrelated to the app build
```

---

## Features

- **File Mode** — Upload WAV / MP3; playback drives a real hardware capture loop (V/I sense) that's analyzed live, not just the decoded file audio
- **Microphone Mode** — Real-time analysis from live microphone / hardware capture input
- **Temperature / Excursion Charts** — L / R / Both channel toggle, ECharts-based live rendering
- **Calibration** — Speaker profile, amp power, ambient temperature, warn/danger thresholds, sample rate/buffer size, and input/output device routing
- **Workspace** — Save a session's captured audio + chart data locally (IndexedDB), export per-item as JSON/CSV, inspect per-channel waveforms

---

## Tech Stack

| Category | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| Charts | Apache ECharts (echarts-for-react) |
| Waveform | wavesurfer.js |
| Analysis Engine | Emscripten (`emcc`) — `electron/native/wasm-engine/ff_prot.c` → WebAssembly, browser target, run in-process (no server) |
| Desktop Packaging | Electron + electron-builder (macOS / Windows / Linux) |

---

## License

Jeonbuk National University SW Industry-Academic Collaboration Project — Redistribution and public disclosure prohibited.
