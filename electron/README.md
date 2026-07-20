# electron (루트)

## 1. 도메인 설명

브라우저에서도 그대로 도는 정적 웹 산출물(`out/`)을 데스크톱 앱 창 하나로 띄우는 얇은 합성 루트다. 이 세 파일(`main.js`/`server.js`/`preload.js`)만 읽으면 "Electron 창이 어떻게 뜨고, `out/`을 어떤 경로로 읽어오며, 렌더러가 네이티브 기능에 접근할 창구가 무엇인지"가 그대로 보인다.

분석 엔진(WASM)은 여전히 렌더러 안에서만 돈다 — 이 도메인은 그 렌더러를 담을 창을 만들고(`main.js`), `out/`을 로컬에서 서빙하고(`server.js`), `sandbox: true`인 렌더러에 오디오 장치·캡처·로컬 폴더 IPC를 최소한으로 노출하는 다리(`preload.js`)만 놓는다. 실제 IPC 채널 등록과 네이티브 헬퍼 실행은 `ipc/`가, macOS CoreAudio 헬퍼 자체는 `native/macos/`가 각각 별도 도메인으로 담당한다.

## 2. 프로젝트 전반에서의 역할

`npm run build:electron`/`build:electron:mac`이 만드는 `dist-electron/` 패키지의 실행 진입점이자, `npm run electron:preview`(`electron .`)로 로컬 `out/`을 그대로 띄울 때도 거치는 경로다.

- `main.js`의 `createWindow()`가 `startServer()`(→ `server.js`)로 로컬 HTTP 서버를 띄운 뒤 `BrowserWindow`가 `http://127.0.0.1:17872/`를 로드한다. Next.js 정적 export는 애셋 경로가 절대경로(`/_next/...`)라 `file://`로 직접 열면 로딩이 깨지기 때문이다.
- `preload.js`가 `contextBridge`로 노출하는 `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder` 4개 브리지는 `shared/types/electron-bridge.d.ts`에 타입으로 선언돼 있고, 브라우저(웹) 빌드에는 이 파일 자체가 없어 전부 `undefined`다 — 소비하는 쪽(`useNativeCapture`/`useNativeAudioDevice`/`useCalibrationApply`/`useCaptureSession`/`useLocalFolderConnection` 등)은 반드시 feature-detect 후 사용한다.
- `main.js`가 앱 종료 라이프사이클(`window-all-closed`/`before-quit`)에서 진행 중인 캡처(`stopCapture`)와 재생+캡처(`stopPlayCapture`), 폴더 감시(`stopWatchingFolder`)를 정리해 네이티브 헬퍼 프로세스가 고아로 남지 않게 한다.
- 실제 IPC 채널 등록은 `main.js`가 `require("./ipc/audio-device")` 등으로 각 `ipc/*.js` 모듈을 불러오는 부수효과로 이뤄진다 — `main.js` 자신은 채널을 하나도 직접 등록하지 않는다.

## 3. 파일별 역할

| 파일 | 역할 |
|------|------|
| `main.js` | Electron 메인 프로세스 진입점. `createWindow()`가 `startServer()` 완료를 기다린 뒤 `contextIsolation: true`/`sandbox: true`/`preload: preload.js`로 `BrowserWindow`를 만들고 로컬 서버 URL을 로드한다. `app.whenReady().then(createWindow)`로 시작하고, `window-all-closed`(macOS 제외 앱 종료)·`before-quit`·`activate`(macOS 독 클릭 시 재생성) 라이프사이클 핸들러가 있다. `ipc/{audio-capture,audio-playcapture,local-folder}`의 정지 함수를 종료 시점에 직접 호출하고, `ipc/audio-device`는 `require`만으로 채널을 등록시킨다(다른 IPC 모듈이 내부적으로 그 헬퍼 경로 해석을 재사용). `IRON_REMOTE_DEBUG_PORT` 환경변수가 있으면 원격 디버깅 포트를 여는 코드가 있는데, 이를 쓰던 Puppeteer 자동화 러너(`scripts/measure.ts`)는 이미 삭제됐다 — Claude의 생각은 이 분기가 지금은 아무 것도 트리거하지 않는 죽은 코드일 가능성이 높다. |
| `server.js` | `out/`을 `127.0.0.1:17872`에서 서빙하는 로컬 HTTP 서버(`http` 모듈, 외부 프레임워크 없음). `OUT_DIR`은 패키징 여부(`app.isPackaged`)에 따라 `process.resourcesPath/out`(패키징됨) 또는 `../out`(개발 중)으로 갈린다. 확장자별 `MIME_TYPES` 테이블로 `Content-Type`을 정하고, 파일이 없으면 `<path>.html`로 재시도해 Next.js 정적 export의 라우트별 HTML 산출물을 서빙한다("/" 는 `path.normalize()` 이전에 `/index.html`로 특수 처리 — Windows에서 normalize가 슬래시를 역슬래시로 바꿔 이 비교가 깨지는 걸 피하려는 순서다). `PORT`(17872)와 `startServer(): Promise<void>`를 export한다. |
| `preload.js` | `contextBridge.exposeInMainWorld`로 4개 전역을 렌더러에 노출한다: `audioDevice`(list/getConfig/setConfig/query), `audioCapture`(start/stop/onData/onEnded), `audioPlayCapture`(startWrite/writeChunk/finalizeWrite/cancelWrite로 재생 참조 PCM을 청크 전송하는 핸드셰이크 + start/control/stop/onData/onEnded), `localFolder`(select/unwatch/readFile/onChanged). 이벤트 구독은 공용 헬퍼 `onIpc(channel, callback)`이 리스너 등록과 해제 함수 반환을 담당한다. 파일 상단 주석은 "audio-device / audio-capture / local-folder"까지만 언급하고 `audioPlayCapture`는 빠져 있다 — Claude의 생각은 이 브리지가 추가된 뒤 주석이 갱신되지 않은 것으로 보인다. |

## 4. 의존성 및 흐름

**이 도메인이 import하는 것** (안쪽 방향):

- `main.js` → `./server`(`PORT`, `startServer`), `./ipc/audio-capture`(`stopCapture`), `./ipc/audio-playcapture`(`stopPlayCapture`), `./ipc/local-folder`(`stopWatchingFolder`), `./ipc/audio-device`(채널 등록 부수효과만, export 미사용), `./preload.js`(경로 문자열로만 참조, `BrowserWindow`의 `preload` 옵션).
- `server.js` → `out/`(빌드 산출물 디렉터리, `scripts/build-static-local.sh`가 생성). 코드로 import하지 않고 파일시스템 경로로만 접근한다.
- 외부 패키지 — `electron`(`app`/`BrowserWindow`/`contextBridge`/`ipcRenderer`), Node 내장 `path`/`http`/`fs`.

**이 도메인을 import하는 것** (바깥 방향):

- `electron-builder`(`electron-builder.yml`) — 패키징 시 `main.js`를 앱 엔트리로 지정.
- 렌더러(브라우저 쪽 전체) — `preload.js`가 노출한 `window.audioDevice`/`audioCapture`/`audioPlayCapture`/`localFolder`를 `src/features/audio/`의 캡처·캘리브레이션·워크스페이스 훅들이 feature-detect 후 소비한다(타입은 `shared/types/electron-bridge.d.ts`).
- 어떤 `src/` 코드도 `electron/`을 정적 import하지 않는다 — 둘 사이의 유일한 접점은 `preload.js`가 만드는 런타임 전역(`window.*`)뿐이다.

**내부 처리 흐름** (앱 시작 → 창 로드):

```
app.whenReady()
  → createWindow()
      → startServer()                         # server.js: out/를 127.0.0.1:17872에서 서빙 시작
      → new BrowserWindow({ preload: preload.js, sandbox: true, contextIsolation: true })
      → win.loadURL("http://127.0.0.1:17872/")  # 렌더러 부팅 — 이후는 WASM 엔진이 인프로세스로 전부 처리
앱 종료(window-all-closed / before-quit)
  → stopWatchingFolder() + stopCapture() + stopPlayCapture()  # 네이티브 헬퍼 프로세스 정리
```

## 5. 주요 인터페이스 / 진입점

- `startServer(): Promise<void>`(`server.js`) — 로컬 서버를 열고 리슨이 시작되면 resolve한다. 실패(포트 충돌 등)하면 reject.
- `PORT = 17872`(`server.js`) — 로컬 서버 포트 상수. `main.js`의 `loadURL`이 그대로 쓴다.
- `window.audioDevice: { list, getConfig, setConfig, query }` — CoreAudio 장치 조회/설정(Electron 전용, 타입은 `shared/types/electron-bridge.d.ts`).
- `window.audioCapture: { start, stop, onData, onEnded }` — 상주 캡처 IOProc 제어.
- `window.audioPlayCapture: { startWrite, writeChunk, finalizeWrite, cancelWrite, start, control, stop, onData, onEnded }` — 파일 재생+캡처 단일 IOProc 제어. `start` 전에 참조 PCM을 `startWrite`→`writeChunk`(반복)→`finalizeWrite`로 청크 전송해 `writeId`를 얻어야 한다(구조화 복제 한 번에 큰 파일을 보내면 메인 프로세스가 멎는 것을 피하기 위함).
- `window.localFolder: { select, unwatch, readFile, onChanged }` — 로컬 폴더 선택/감시/읽기.

주의사항: 위 4개 전역은 전부 **브라우저 빌드에는 존재하지 않는다**. `typeof window.audioDevice !== "undefined"` 류의 feature-detect 없이 호출하면 웹 빌드에서 즉시 예외가 난다.

## 6. 변경 이력(요약)
- 2026-07-20: 최초 작성 (기준 커밋: fb8e4fa — `electron/`은 `.gitignore`(`/electron/`)로 커밋 이력 추적 밖에 있어 git log 대신 현재 코드를 직접 읽어 작성)
