# Iron Device Simulator

A web-based dashboard for demonstrating Iron Device Corporation's speaker protection algorithm library (`libirontune.so`), developed as part of a Jeonbuk National University SW industry-academic collaboration project.

Visualizes **speaker temperature** and **excursion displacement** in real-time via audio file upload or live microphone input.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## Modes

| Mode | Engine | Platform |
|---|---|---|
| **Mock** | Formula-based simulation | macOS / Linux / Windows |
| **Native** | Direct `libirontune.so` call (koffi FFI) | Linux x86-64 (Docker + QEMU on other platforms) |
| **WASM** | `native/ff_prot.c` compiled to WebAssembly | Any platform (Docker, no QEMU needed) |

> `libirontune.so` is an ELF 64-bit x86-64 binary (Ubuntu / GCC 5.4.0) and cannot be loaded directly on macOS or Windows — hence Native mode requires Docker (emulated via QEMU on non-x86-64 hosts).
>
> `native/ff_prot.c` is a reference/stub implementation matching the same `ff_prot_*` FFI signature as `libirontune.so` (the real vendor source hasn't been provided yet). **WASM mode** compiles this stub with Emscripten and runs it directly inside Node's `WebAssembly` runtime — no FFI, no ELF loading, no QEMU. It's a drop-in replacement for Native mode until the real `.so` is available. See `native/README.md`.

---

## Requirements

### Common
- Node.js 20+
- npm 9+

### Native Mode Only
- `libirontune.so` binary

### WASM Mode Only
- Docker (to build/run via `scripts/run-wasm-docker.sh`), **or**
- [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) (`emcc`) to build `native/wasm/ff_prot.js` locally

---

## Installation

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## Running by OS

### macOS — Mock Mode (Local Development)

```bash
npm run dev
```

Open http://localhost:3000 in your browser.

---

### macOS — Native Mode (Docker)

> On macOS, use `scripts/run-native-docker.sh`.

Edit `SO_HOST` in the script to point to your local `.so` file, then run:

```bash
vi scripts/run-native-docker.sh   # set SO_HOST path
./scripts/run-native-docker.sh
```

On Apple Silicon (M1/M2/M3/M4), the container runs under QEMU x86-64 emulation. The initial build may take a while.

**colima setup (if using colima):**

```bash
colima start --arch x86_64 --memory 4
```

---

### Any OS — WASM Mode (Docker)

Compiles `native/ff_prot.c` to WebAssembly and runs the real dashboard against it — no `.so` file, no `--platform` pin, no QEMU. Builds and runs natively on your host architecture (including Apple Silicon).

```bash
./scripts/run-wasm-docker.sh
```

Open http://localhost:3002 in your browser. Under the hood: `Dockerfile.wasm` compiles `native/ff_prot.c` with Emscripten (Node target) in a build stage, then bakes the resulting `native/wasm/ff_prot.js` into the runtime image and starts the server with `ENGINE=wasm`.

**Run directly (without Docker), given a local Emscripten install:**

```bash
cd native && ./build-wasm.sh && cd ..
ENGINE=wasm WASM_PATH=$(pwd)/native/wasm/ff_prot.js npx tsx server.ts
```

---

### Linux x86-64 — Mock Mode

```bash
npm run dev
```

---

### Linux x86-64 — Native Mode

> On Linux, use `scripts/run-native-linux.sh`.

**Run via script (recommended):**

```bash
vi scripts/run-native-linux.sh   # set SO_HOST path
./scripts/run-native-linux.sh
```

**Run directly:**

```bash
USE_MOCK=false SO_PATH=/path/to/libirontune.so npx tsx server.ts
```

---

### Windows — Mock Mode

```powershell
npm run dev
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ENGINE` | `mock` | `mock` \| `native` \| `wasm` — selects the analysis engine. Takes priority over `USE_MOCK` |
| `USE_MOCK` | `true` | Legacy toggle, kept for backward compatibility: `false` → `native` when `ENGINE` is unset |
| `SO_PATH` | `/app/native/libirontune.so` | Absolute path to the `.so` file (Native mode) |
| `WASM_PATH` | `/app/native/wasm/ff_prot.js` | Absolute path to the compiled WASM module (WASM mode, built by `native/build-wasm.sh`) |
| `USE_QUEUE` | `true` | Set to `false` to use the plain FIFO render path instead of the output-queue scheduler |
| `PORT` | `3000` | Shared HTTP / WebSocket port |
| `LOG_FRAME_INTERVAL` | `10` | Print frame log every N frames |
| `LOG_LEVEL` | — | Set to `silent` to suppress frame logs |

---

## Dev Commands

```bash
npm run dev          # Dev server (Mock mode, HMR enabled) — runs server.ts via tsx
npm run build        # Next.js production build
npm run build:server # Compile server.ts → server.js (required before npm start)
npm start            # Production server (node server.js)
npm run start:dev    # Prod-mode run without build (NODE_ENV=production tsx server.ts)
npm run lint         # ESLint
```

### Measurement Harness (server must already be running)

```bash
npm run measure              # Puppeteer auto-measurement → measurements/*.json
npm run measure:baseline     # label=baseline, 60s/track
npm run compare              # Summarize / diff measurements/*.json
```

### WASM Build (`native/`)

```bash
cd native
make                  # → libirontune.so (reference stub, Linux x86-64)
make selftest         # pure-C self-test (temperature rise + L/R excursion diff)
./build-wasm.sh       # → wasm/ff_prot.js (Emscripten, Node target, requires emcc)
```

---

## Features

- **File Mode** — Upload WAV / MP3 and get real-time analysis synced to playback
- **Microphone Mode** — Real-time analysis from browser microphone input
- **Temperature / Excursion Charts** — L / R / Both channel toggle, ECharts-based live rendering
- **Realtime / Batch modes** — Stream synced to playback, or analyze the whole file up front
- **Debug Panel** — RTT, server processing time, React/ECharts render pipeline metrics
- **Measurement Mode** — Record a session and export as JSON

---

## Tech Stack

| Category | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| Charts | Apache ECharts (echarts-for-react) |
| Waveform | wavesurfer.js |
| Native FFI | koffi |
| WASM | Emscripten (`emcc`) — `native/ff_prot.c` → WebAssembly, Node target |
| Container (Native) | Docker (node:20-slim, `linux/amd64`, QEMU on other hosts) — `Dockerfile` |
| Container (WASM) | Docker (node:20-slim, host-native arch, no QEMU) — `Dockerfile.wasm` |

---

## License

Jeonbuk National University SW Industry-Academic Collaboration Project — Redistribution and public disclosure prohibited.
