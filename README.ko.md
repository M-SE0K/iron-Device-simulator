# Iron Device Simulator

[English](README.md) | 한국어

전북대학교 SW 산학협력 프로젝트로 개발된, Iron Device Corporation의 스피커 보호 알고리즘 라이브러리(`libirontune.so`)를 시연하기 위한 웹 기반 대시보드입니다.
오디오 파일 업로드 또는 실시간 마이크 입력으로 **스피커 온도**와 **진동판 변위(excursion)**를 실시간으로 시각화합니다.

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## 요구 사항

- Node.js 20+
- npm 9+
- [Emscripten](https://emscripten.org/docs/getting_started/downloads.html)(`emcc`) — WASM 엔진 빌드용(`npm run wasm:build`)
- Electron 패키징에만 필요: `electron` / `electron-builder`는 이미 devDependencies에 포함돼 있어 별도 설치가 필요 없습니다. macOS/Linux에서 Windows NSIS 설치 프로그램을 크로스 컴파일하려면 Wine이 필요한데, 그래서 이 프로젝트의 Windows 타깃은 서명·Wine 없이도 만들 수 있는 포터블 `.zip`으로 대신합니다(자세한 내용은 [데스크톱 앱 패키징(Electron)](#데스크톱-앱-패키징electron) 참고).

---

## 설치

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## 빌드

### 웹 (모든 정적 호스트)

```bash
npm run build:desktop   # → out/ (WASM 컴파일 + next build --output export)
npx serve out            # 정적 번들을 로컬에서 서빙
```

`serve`가 출력한 URL(기본값 http://localhost:3000)을 열면 됩니다. `out/`은 순수한 정적 사이트이므로 Vercel, Cloudflare Pages, Netlify, GitHub Pages, S3, Nginx 등 어떤 정적 호스트에도 동일한 방식으로 배포할 수 있습니다.

> `out/index.html`을 `file://`로 직접 여는 것은 동작하지 않습니다 — 애셋 경로가 절대 경로(`/_next/...`)이기 때문에 반드시 웹 루트에서 서빙해야 합니다.

### 데스크톱 앱 패키징(Electron)

```bash
npm run build:electron   # → out/ (WASM + 정적 export) + dist-electron/ (패키징된 앱)
```

`build:desktop`과 동일한 정적 코어 빌드를 실행한 뒤, [electron-builder](https://www.electron.build/)로 감싸 **macOS, Windows, Linux**(`x64`, `arm64` 모두) 설치형 데스크톱 앱 6종을 `dist-electron/` 아래에 생성합니다.

| 플랫폼 | 산출물 |
|---|---|
| macOS | `.dmg`, `.zip` (x64 + arm64) |
| Windows | `.zip` 포터블 (x64 + arm64) |
| Linux | `.AppImage` (x64 + arm64) |

`electron/main.js`는 `127.0.0.1`에 바인딩된 작은 로컬 HTTP 서버를 띄워 `out/`을 `BrowserWindow`에 서빙합니다 — 위 웹 빌드와 같은 이유(절대 애셋 경로)로 `file://`을 직접 로드하면 동작하지 않습니다. 백엔드도, `ws://` 연결도 없습니다. WASM 엔진은 웹 빌드와 마찬가지로 여전히 Electron 렌더러 프로세스 내부에서 전부 실행됩니다.

**이 빌드들은 서명되지 않았습니다**(앱스토어/공개 배포용이 아니라 팀 내부 배포용 — `electron-builder.yml` 참고). 최초 실행 시 다음 한 단계가 필요합니다.

- **macOS**: 앱을 우클릭 → 열기 (더블클릭으로 실행하면 Gatekeeper가 서명되지 않은 앱을 차단합니다)
- **Windows**: SmartScreen 경고에서 "추가 정보" → "실행" 클릭
- **Linux**: `chmod +x *.AppImage` 후 바로 실행 — 별도 경고 없음

전체 패키징 없이 미리보기만 하려면(이미 어떤 정적 빌드로든 `out/`이 만들어져 있는 상태에서):

```bash
npm run electron:preview   # electron . — electron/main.js를 현재 out/ 기준으로 실행
```

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `USE_QUEUE` | `true` | `false`로 설정하면 출력 큐 스케줄러 대신 단순 FIFO 렌더 경로를 사용합니다. 렌더 시점에 서버 사이드에서 읽으므로(`next build && next start`) 정적 export 빌드에는 반영되지 않습니다. |

---

## 개발 명령어

```bash
npm run dev          # next dev — HMR 지원 개발 서버 (WASM 엔진 항상 활성)
npm run build        # Next.js 프로덕션 빌드
npm start            # 프로덕션 서버 (next start)
npm run lint         # ESLint

npm run wasm:build    # electron/native/wasm-engine/ff_prot.c를 브라우저 타깃 WASM으로 컴파일, emcc 필요
npm run build:desktop # 정적 웹 빌드 → out/ (위 빌드 항목 참고)
npm run build:electron # 정적 빌드 + Electron 패키징 → out/ + dist-electron/ (위 빌드 항목 참고)
npm run electron:preview # electron . — 현재 out/ 기준으로 electron/main.js 실행, 패키징 없음
```

수동 측정: 앱에서 세션을 재생한 뒤 브라우저 콘솔에서 `window.__ironPerf.summary()` / `.download()`를 실행하세요.

### WASM 빌드 (`electron/native/wasm-engine/`)

> 이 폴더는 `electron/` 밑에 있지만 Electron 전용이 아닙니다 — 산출물
> (`public/wasm/ff_prot.{js,wasm}`)은 순수 웹 빌드에도 그대로 쓰입니다.

```bash
cd electron/native/wasm-engine
./build-wasm.sh       # → ../../../public/wasm/ff_prot.{js,wasm} (Emscripten, 브라우저 타깃, emcc 필요)
make selftest         # 참조 모델의 순수 C 자체 테스트(온도 상승 + L/R excursion 차이) — 앱 빌드와는 무관
```

---

## 기능

- **파일 모드** — WAV / MP3를 업로드하면, 재생이 실제 하드웨어 캡처 루프(V/I 센싱)를 구동하고 그 결과를 실시간으로 분석합니다 — 디코딩된 파일 오디오 자체를 분석하는 것이 아닙니다
- **마이크 모드** — 실시간 마이크 / 하드웨어 캡처 입력을 실시간으로 분석
- **온도 / Excursion 차트** — L / R / Both 채널 토글, ECharts 기반 실시간 렌더링
- **캘리브레이션** — 스피커 프로필, 앰프 출력, 주변 온도, 경고/위험 임계값, 샘플레이트/버퍼 크기, 입출력 장치 라우팅 설정
- **워크스페이스** — 세션의 캡처 오디오와 차트 데이터를 로컬(IndexedDB)에 저장, 항목별 JSON/CSV export, 채널별 파형 확인

---

## 기술 스택

| 분류 | 기술 |
|---|---|
| 프레임워크 | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| 차트 | Apache ECharts (echarts-for-react) |
| 파형 | wavesurfer.js |
| 분석 엔진 | Emscripten(`emcc`) — `electron/native/wasm-engine/ff_prot.c` → WebAssembly, 브라우저 타깃, 프로세스 내부 실행(서버 없음) |
| 데스크톱 패키징 | Electron + electron-builder (macOS / Windows / Linux) |

---

## 라이선스

전북대학교 SW 산학협력 프로젝트 — 재배포 및 공개 금지.
