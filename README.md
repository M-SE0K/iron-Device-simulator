# Iron Device Simulator

A web-based dashboard for demonstrating Iron Device Corporation's speaker protection algorithm library (`libirontune.so`), developed as part of a Jeonbuk National University SW industry-academic collaboration project.

Visualizes **speaker temperature** and **excursion displacement** in real-time via audio file upload or live microphone input.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## Modes

| Mode | Engine | Platform |
|---|---|---|
| **Mock** | Formula-based simulation | macOS / Linux / Windows |
| **Native** | Direct `libirontune.so` call | Linux x86-64 (Docker required) |

> `libirontune.so` is an ELF 64-bit x86-64 binary (Ubuntu / GCC 5.4.0) and cannot be loaded directly on macOS or Windows.

---

## Requirements

### Common
- Node.js 20+
- npm 9+

### Native Mode Only
- Docker (colima / Docker Desktop)
- `libirontune.so` binary

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

> On macOS, use `script/run-native-docker.sh`.

Edit `SO_HOST` in the script to point to your local `.so` file, then run:

```bash
vi script/run-native-docker.sh   # set SO_HOST path
./script/run-native-docker.sh
```

On Apple Silicon (M1/M2/M3/M4), the container runs under QEMU x86-64 emulation. The initial build may take a while.

**colima setup (if using colima):**

```bash
colima start --arch x86_64 --memory 4
```

---

### Linux x86-64 — Mock Mode

```bash
npm run dev
```

---

### Linux x86-64 — Native Mode

> On Linux, use `script/run-native.sh`.

**Run via script (recommended):**

```bash
vi script/run-native.sh   # set SO_HOST path
./script/run-native.sh
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
| `USE_MOCK` | `true` | Set to `false` to use the Native engine |
| `SO_PATH` | `/app/native/libirontune.so` | Absolute path to the `.so` file |
| `PORT` | `3000` | Shared HTTP / WebSocket port |
| `LOG_FRAME_INTERVAL` | `10` | Print frame log every N frames |
| `LOG_LEVEL` | — | Set to `silent` to suppress frame logs |

---

## Dev Commands

```bash
npm run dev      # Dev server (Mock mode, HMR enabled)
npm run build    # Production build
npm start        # Production server
npm run lint     # ESLint
```

---

## Features

- **File Mode** — Upload WAV / MP3 and get real-time analysis synced to playback
- **Microphone Mode** — Real-time analysis from browser microphone input
- **Temperature / Excursion Charts** — L / R / Both channel toggle, ECharts-based live rendering
- **Debug Panel** — RTT, server processing time, React/ECharts render pipeline metrics
- **Measurement Mode** — Record a session and export as JSON

---

## Tech Stack

| Category | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| Charts | Apache ECharts (echarts-for-react) |
| Native FFI | koffi |
| Container | Docker (node:20-slim, linux/amd64) |

---

## License

Jeonbuk National University SW Industry-Academic Collaboration Project — Redistribution and public disclosure prohibited.
