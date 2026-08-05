# Iron Device Simulator

English | [한국어](README.ko.md)

A **desktop app** for demonstrating Iron Device Corporation's speaker protection algorithm, developed as part of a Jeonbuk National University SW industry-academic collaboration project.
While an audio file plays, it **captures the speaker's voltage (V) and current (I) sensing signals from real hardware**, runs them through the protection algorithm (compiled to WebAssembly), and visualizes **speaker temperature** and **cone excursion (displacement)** in real time.

The architecture is fully **server-less** — no server, no database, no login. The analysis engine runs directly inside the app (the Tauri WebView), and audio playback and capture are handled by a per-platform native helper (macOS CoreAudio / Windows ASIO) in a **single IOProc**, so playback and capture share one clock.

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

**① Algorithm sources** — drop your `.c`/`.h` files into `native/wasm-engine/custom/` and `build-wasm.sh` compiles only that folder's sources instead of the reference stub in the parent folder. Filenames are up to you, but the **four export symbols** `ff_prot_init` / `ff_prot_set_param` / `ff_prot_start_exec` (9 args) / `ff_prot_stop_exec` are fixed — the JS side calls those names directly. If your existing algorithm uses different function names, just add a single delegating wrapper. See `native/wasm-engine/custom/README.md` for the full contract.

**② ASIO SDK** — only needed to compile the Windows native audio helper (ASIO). It is not included in the repository due to redistribution restrictions; you can also point elsewhere with `ASIOSDK_DIR=<path>`. Not required if you only build macOS/Linux targets.

---

## Installation

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## Quick Start

One command right after cloning (checks the environment → `npm install` → WASM build → dev server startup check).

```bash
npm run bootstrap
npm run build:tauri:{mac, windows}
```

The dev server is **shut down automatically once an actual HTTP response is confirmed**, so there is no need to press `Ctrl + C`. To prepare everything without starting the server, prefix `BOOTSTRAP_NO_DEV=1`; on a slow machine, raise the startup wait with `BOOTSTRAP_DEV_TIMEOUT=180`.

The script does not fail if the algorithm sources are not in place yet — it finishes `npm install`, skips the engine build, then tells you what to put where and exits.

At the end it checks the prerequisites you will eventually need for desktop packaging — Rust toolchain, WebKitGTK (Linux), Xcode CLT (macOS), Java, ASIO SDK — and lists **only the ones actually missing**, each with its install command.

> ⚠️ The browser tab opened by `npm run dev` is **for UI inspection only**. Device control, hardware capture, and file playback work only through the Tauri native bridges (`window.audioDevice` and friends), so verify actual behavior with `npm run tauri:preview` or a packaged app.

### Desktop App Packaging

`scripts/build/build-tauri.sh` wraps the static core (`out/`, the browser WASM engine) and the native audio helpers (`native/`) with the Tauri v2 bundler, producing artifacts under `dist-tauri/{mac,windows,linux}/`.

```bash
npm run build:tauri             # with no flags, builds only the current host OS's target (see constraint below)
npm run build:tauri:mac         # macOS only (must run on macOS)
npm run build:tauri:windows     # Windows only (Windows, or cross-built from WSL/Linux)
npm run build:tauri:linux       # Linux only (must run on Linux; no native helper)
npm run tauri:preview           # npx tauri dev — runs against the current out/, no packaging
```

**Extra prerequisites**: the Rust toolchain (`cargo`, [rustup.rs](https://rustup.rs)) and, on Linux/WSL, `libwebkit2gtk-4.1-dev pkg-config libssl-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev`. `npm run bootstrap` / `scripts/setup/setup-*.sh` check for these and only print a notice if missing (non-blocking).

**Important constraint — host OS = target OS (with one experimental exception)**: Tauri requires the host OS to match the target OS (mac artifacts on macOS, Linux artifacts on Linux). That is why `build:tauri` with no flags builds only the current machine's target, and why `build:tauri:mac`/`build:tauri:linux` on the wrong host exit with a clear error instead of silently doing nothing.

`build:tauri:windows` is the one exception: it builds normally on a native Windows host, but **it also works from WSL/Linux** — via Tauri's [experimental cross-compilation path](https://v2.tauri.app/distribute/windows-installer/) (`cargo-xwin` + NSIS). `scripts/build/build-tauri.sh` auto-detects a Linux host and switches to that path with no extra flags. It's a convenience for iterating without a Windows machine on hand; because upstream (Tauri) marks the path as experimental, **treat a real Windows build as the authoritative/fallback path** and re-verify install/run on real Windows before shipping. Extra prerequisites for the cross path (on top of the Rust toolchain above):

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
sudo apt install nsis clang lld llvm    # makensis + the linker/codegen tools cargo-xwin needs
```

You mostly do not have to prepare these by hand — `build-tauri.sh` checks the toolchain **before packaging starts** and installs the sudo-free rustup/cargo pieces automatically (default toolchain via `rustup install stable`, the Windows target, `cargo install cargo-xwin`). This exists to stop the build from spending minutes on the static bundle and the ASIO helper only to die at the final step over a missing toolchain. Set `TAURI_NO_AUTO_INSTALL=1` to opt out — it then prints the exact commands and stops. The apt packages that need sudo (`clang lld llvm`, `nsis`) are never installed automatically; they only produce a warning and the build continues.

The first cross-build downloads the MS CRT/SDK into `~/.cache` (network required, a few minutes) — subsequent builds reuse the cache.

If cross-compiling the Windows helper (ASIO) fails, **the entire build fails** — a deliberate behavior that prevents accidentally packaging a stale committed `.exe` without noticing. To use the existing `.exe` as-is on a machine without the toolchain, set `SKIP_WIN_HELPER_BUILD=1`.

The macOS build applies an **ad-hoc signature** to the whole app so that Apple
Silicon does not misclassify a browser-downloaded app as "damaged". It is not a
Developer ID notarized build, though, and is intended for internal team
distribution. First launch requires one step:

- **macOS**: after the first launch is blocked, go to System Settings → Privacy & Security → "Open Anyway"
- **Windows**: on the SmartScreen warning, click "More info" → "Run anyway"
- **Linux**: `chmod +x *.AppImage` then run directly — no warning

### DevTools Lockdown and Measurement-Only Builds

Distribution builds have **no developer tools compiled in at all.** The `devtools` cargo feature is off by default, so the WebView inspector itself is excluded (`isInspectable`/`AreDevToolsEnabled` forced to false), remote debugging arguments (`--remote-debugging*`) and the related environment variables are blocked/stripped at launch, and the shortcuts (F12, Cmd+Opt+I, Ctrl+Shift+I/J/C, Ctrl+U) and the context menu are blocked as well. See `docs/devtools-hardening-plan.md` for details.

Work that needs a console — such as performance measurement (`window.__ironPerf`) — requires a separate **measurement-only build** made with `--devtools`. Do not use it for distribution.

```bash
npm run build:tauri:mac -- --devtools
```

### Engine Protection (Obfuscation · Encrypted Distribution)

Once the production algorithm is in place, there is a path to prevent a plaintext `.wasm` from sitting in the package where a file browser can lift it straight out. Since there is no server, the decryption material ultimately has to ship inside the app binary — so this is not cryptographic confidentiality but **a defense layer that raises the cost of reverse engineering**.

- **Build hardening / obfuscation** — building with `FF_PROT_HARDEN=1 npm run wasm:build` applies, in order: Emscripten hardening flags (`-flto -g0 --closure 1`) → `wasm-opt` strip → `wasm-mutate` structural transformation → constant XOR obfuscation → glue JS obfuscation. Only the structural transformation step requires `cargo install wasm-tools`; without it the step is skipped non-destructively. See `native/wasm-engine/custom/README.md` for the tuning knobs.
- **Encrypted distribution** — at packaging time, `scripts/build/stage-encrypted-wasm.sh` encrypts the `.wasm` with AES-256-GCM, ships it as `src-tauri/resources/ff_prot.wasm.enc`, and deletes the plaintext copy from `out/`. The decryption key is not baked into the binary as a constant; it is **derived at runtime with HKDF-SHA256** from seed material (`.wasm-seed`, generated once per machine, excluded from git) and bound to the distribution context via the GCM AAD. The full flow is documented in `docs/wasm-encryption.md`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `USE_QUEUE` | `true` | Set to `false` to use the plain FIFO render path instead of the output-queue scheduler. |
| `USE_WORKER_ENGINE` | `1` | By default the analysis engine runs in a Web Worker so the main thread only handles UI rendering. Set to `0` to run it directly on the main thread (the same path is also used as a fallback if worker creation fails). |

Some variables are used at build time only.

| Variable | Description |
|---|---|
| `WASM_MODE` | Build a `debug` (printf dump of V/I values) or `dummy` (pass B attenuation never engages) WASM — for value verification only; do not use for latency measurement. |
| `FF_PROT_HARDEN` | `1` enables the WASM obfuscation/hardening pipeline (see "Engine Protection" above). |
| `SKIP_WIN_HELPER_BUILD` | `1` skips recompiling the Windows ASIO helper and uses the committed `.exe`. |
| `ASIOSDK_DIR` | Point at the ASIO SDK directly instead of the default path. |
| `TAURI_NO_AUTO_INSTALL` | `1` disables automatic toolchain installation for the Windows cross build; it prints the required commands and stops instead. |
| `BOOTSTRAP_NO_DEV` | `1` makes `npm run bootstrap` skip the dev-server startup check. |
| `BOOTSTRAP_DEV_TIMEOUT` | Seconds `npm run bootstrap` waits for the dev server to come up (default `90`). |

## Dev Commands

These commands are written excluding web behavior — they're Tauri dev commands, so please use them with that in mind.

```bash
npm run wasm:build          # compile the C sources in native/wasm-engine to browser-target WASM
                            #   (falls back to a Docker image if emcc is missing)
npm run wasm:preview        # rebuild only the WASM after an algorithm-only change, then relaunch the Tauri preview
npm run build:desktop       # static build → out/ (see the build section above)
npm run build:tauri         # {:mac, :windows, :linux} static build + Tauri packaging → out/ + dist-tauri/
npm run tauri:preview       # npx tauri dev — runs against the current out/, no packaging.
```

## Tech Stack

| Category | Technology |
|---|---|
| Framework | Next.js 15 (App Router, static export) |
| UI | React 19 · Tailwind CSS |
| Charts | µPlot (uplot) — real-time streaming render |
| Analysis Engine | WebAssembly compiled with Emscripten (`emcc`) — Web Worker by default, main thread as fallback (no server) |
| Native Audio | macOS CoreAudio (Swift) / Windows ASIO (C++, mingw cross) helpers — single IOProc for playback + capture |
| Desktop Packaging | Tauri v2 (Rust) — macOS / Windows / Linux, artifacts under `dist-tauri/` |

## License

Copyright (C) 2026 Iron Device Corporation and JBNU-CILAB.

This project is free and open-source software licensed under the
[GNU General Public License v3.0 only](LICENSE) (`GPL-3.0-only`).
Third-party components remain subject to their respective licenses.
