# Iron Device Simulator

A web-based dashboard for demonstrating Iron Device Corporation's speaker protection algorithm library (`libirontune.so`), developed as part of a Jeonbuk National University SW industry-academic collaboration project.

Visualizes **speaker temperature** and **excursion displacement** in real-time via audio file upload or live microphone input.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## Architecture: Browser-Only WASM Engine, No Server

There is no backend for the analysis pipeline — everything runs client-side. `native/ff_prot.c` (a reference/stub implementation matching the real vendor `libirontune.so`'s `ff_prot_*` signature; the real vendor source hasn't been provided yet, see `native/README.md`) is compiled with Emscripten to browser-target WebAssembly (`public/wasm/ff_prot.{js,wasm}`) and executed directly in the browser's `WebAssembly` runtime via `src/features/audio/lib/engine/adapters/wasm-client.ts`. `engine/protocol/local-socket.ts` wraps this in a `WebSocket`-shaped interface so the player components (`WaveformPlayer.tsx` / `MicrophonePlayer.tsx`) don't need to know the analysis is in-process.

This means the app is a plain static site — the same build works as a normal web deployment, a desktop standalone bundle, or a Capacitor mobile app; see [Building](#building) below.

---

## Requirements

- Node.js 20+
- npm 9+
- [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) (`emcc`) — to build the WASM engine (`npm run wasm:build`)
- Mobile packaging only: Xcode (iOS) and/or Android Studio (Android) installed and configured for Capacitor. `@capacitor/cli` is already a devDependency, so no separate install is needed for the `npx cap ...` commands themselves.

---

## Installation

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## Running Locally

```bash
npm run wasm:build   # once — compiles native/ff_prot.c → public/wasm/ff_prot.{js,wasm}, requires emcc
npm run dev           # next dev — http://localhost:3000
```

---

## Building

### Web (any static host)

```bash
npm run build:desktop   # → out/ (compiles WASM + next build --output export)
npx serve out            # serve the static bundle locally
```

Open the URL `serve` prints (defaults to http://localhost:3000). `out/` is a plain static site — deploy it to any static host (Vercel, Cloudflare Pages, Netlify, GitHub Pages, S3, Nginx, etc.) the same way.

> Opening `out/index.html` directly via `file://` will **not** work — asset paths are absolute (`/_next/...`), so it must be served from a web root.

### Mobile Packaging (Capacitor iOS/Android)

```bash
npm run build:mobile    # → out/ (same static + WASM build as the web build)
npm run cap:sync        # npx cap sync — copies out/ into the ios/ and android/ native projects
npx cap open ios        # or: npx cap open android
```

Then build and run from Xcode / Android Studio as usual. `capacitor.config.ts` (`webDir: "out"`) is what tells Capacitor where to pull the bundle from.

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

npm run wasm:build    # Compile native/ff_prot.c to browser-target WASM, requires emcc
npm run build:desktop # Static web build → out/ (see Building above)
npm run build:mobile  # Static, Capacitor-ready mobile build → out/ (see Building above)
npm run cap:sync      # npx cap sync — sync out/ into the Capacitor ios/android native projects
```

### Measurement Harness (dev server must already be running)

```bash
npm run measure              # Puppeteer auto-measurement → measurements/*.json
npm run measure:baseline     # label=baseline, 60s/track
npm run compare              # Summarize / diff measurements/*.json
```

### WASM Build (`native/`)

```bash
cd native
./build-wasm.sh       # → ../public/wasm/ff_prot.{js,wasm} (Emscripten, browser target, requires emcc)
make selftest         # pure-C self-test of the reference model (temperature rise + L/R excursion diff), unrelated to the app build
```

---

## Features

- **File Mode** — Upload WAV / MP3 and get real-time analysis synced to playback
- **Microphone Mode** — Real-time analysis from browser microphone input
- **Temperature / Excursion Charts** — L / R / Both channel toggle, ECharts-based live rendering
- **Realtime / Batch modes** — Stream synced to playback, or analyze the whole file up front
- **Debug Panel** — RTT, processing time, React/ECharts render pipeline metrics
- **Measurement Mode** — Record a session and export as JSON

---

## Tech Stack

| Category | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| Charts | Apache ECharts (echarts-for-react) |
| Waveform | wavesurfer.js |
| Analysis Engine | Emscripten (`emcc`) — `native/ff_prot.c` → WebAssembly, browser target, run in-process (no server) |
| Mobile Packaging | Capacitor (iOS / Android) |

---

## License

Jeonbuk National University SW Industry-Academic Collaboration Project — Redistribution and public disclosure prohibited.
