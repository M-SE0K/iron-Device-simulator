# Iron Device Simulator

English | [한국어](README.ko.md)

A web-based dashboard for demonstrating Iron Device Corporation's speaker protection algorithm library (`libirontune.so`), developed as part of a Jeonbuk National University SW industry-academic collaboration project.
Visualizes **speaker temperature** and **cone excursion (displacement)** in real time from an uploaded audio file or live microphone input.

**Move the SDK shared on Teams to the path below before proceeding — packaging will not work unless `third_party` is added.**
```
./iron-Device-simulator
└──native
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

### Desktop App Packaging

Wraps the static core build (`out/`, browser WASM engine) and the native audio helpers (`native/`) with the Tauri v2 bundler, producing artifacts under `dist-tauri/{mac,windows,linux}/` via `scripts/build/build-tauri.sh`. (This project previously also shipped an Electron package alongside Tauri — that shell has since been fully removed in favor of Tauri alone.)

```bash
npm run build:tauri             # builds only the current host OS's target (see constraint below)
npm run build:tauri:mac         # macOS only (must run on macOS)
npm run build:tauri:windows     # Windows only (must run on Windows)
npm run build:tauri:linux       # Linux only (must run on Linux)
npm run tauri:preview           # npx tauri dev — runs against the current out/, no packaging
```

**Extra prerequisites**: the Rust toolchain (`cargo`, via [rustup.rs](https://rustup.rs)) and, on Linux/WSL, `libwebkit2gtk-4.1-dev pkg-config libssl-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev`. `npm run bootstrap` / `scripts/setup/setup-*.sh` check for these and print a friendly, non-blocking notice if missing.

**Important constraint — host OS = target OS (with one experimental exception)**: unlike electron-builder (used by this project's now-removed Electron shell), Tauri requires the host OS to match the target OS (mac artifacts must be built on macOS, Linux artifacts on Linux). `build:tauri` therefore builds only the current machine's target by default; `build:tauri:mac`/`build:tauri:linux` on the wrong host exit with a clear error instead of silently doing nothing.

`build:tauri:windows` is the one exception: on a native Windows host it builds normally, but running it **from WSL/Linux now also works**, via Tauri's [experimental cross-compilation path](https://v2.tauri.app/distribute/windows-installer/) (`cargo-xwin` + NSIS) — this repo's `scripts/build/build-tauri.sh` auto-detects a Linux host and switches to that path, no flags needed. It's a convenience for iterating without a Windows machine handy; because it's experimental upstream, **treat a real Windows build as the authoritative/fallback path** and re-verify install/run on real Windows before shipping. Extra prerequisites for the cross path (on top of the Rust toolchain above):

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
sudo apt install nsis clang lld llvm    # makensis + the linker/codegen bits cargo-xwin needs
```

The first cross-build downloads the MS CRT/SDK into `~/.cache` (network required, a few minutes); subsequent builds reuse the cache.

Both shells produce **unsigned builds** (intended for internal team distribution, not app-store/public release). First launch requires one manual step, same for either shell:

- **macOS**: right-click the app → Open (Gatekeeper blocks unsigned apps opened by double-click)
- **Windows**: click "More info" → "Run anyway" on the SmartScreen warning
- **Linux**: `chmod +x *.AppImage` then run directly — no warning

### Known Limitations

- **E2E latency measurement has no automated remote-debugging path on macOS.** `scripts/실험용/measure-e2e-latency.sh` and friends can drive Chrome DevTools Protocol (CDP) remote debugging on Windows via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, but macOS's WKWebView has no CDP support — there is no equivalent automated path there (manual measurement via Safari Web Inspector's console still works; see `docs/e2e-latency-experiment.md`).
- **Tauri cross-packaging is limited, not impossible.** Windows artifacts can now be cross-built from WSL/Linux via the experimental `cargo-xwin` path described above — plan the final validation pass on real Windows regardless. macOS still requires an actual Mac (no cross path exists or is planned here); Linux artifacts still require a Linux host.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `USE_QUEUE` | `true` | Set to `false` to use the plain FIFO render path instead of the output-queue scheduler.  |
| `USE_WORKER_ENGINE` | `1` | Set from `0` to `1` to offload the main thread's work, so it can proceed with UI rendering only. |


## Dev Commands

These commands are written excluding web behavior — they're Tauri dev commands, so please use them with that in mind.

```bash
npm run wasm:build          # compile native/wasm-engine/*.c to browser-target WASM (emcc, falls back to Docker if missing)
npm run wasm:preview        # rebuild just the WASM output after an algorithm-only change, then relaunch the Tauri preview
npm run build:desktop       # static build → out/ (see the build section above)
npm run build:tauri         # {:mac, :windows, :linux} static build + Tauri packaging → out/ + dist-tauri/ (see the build section above)
npm run tauri:preview       # npx tauri dev — runs against the current out/, no packaging. Quick way to check the app environment (mainly for use during development).
```

## Tech Stack

| Category | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| Charts | Apache ECharts (echarts-for-react) |
| Waveform | wavesurfer.js |
| Analysis Engine | Emscripten (`emcc`) — `native/wasm-engine/ff_prot.c` → WebAssembly, browser target, run in-process (no server) |
| Desktop Packaging | Tauri v2 (Rust) — macOS / Windows / Linux, artifacts under `dist-tauri/` |


## License

Jeonbuk National University SW Industry-Academic Collaboration Project — Redistribution and public disclosure prohibited.
