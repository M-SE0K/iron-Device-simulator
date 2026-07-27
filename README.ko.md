# Iron Device Simulator

[English](README.md) | 한국어

전북대학교 SW 산학협력 프로젝트로 개발된, Iron Device Corporation의 스피커 보호 알고리즘 라이브러리(`libirontune.so`)를 시연하기 위한 웹 기반 대시보드입니다.
오디오 파일 업로드 또는 실시간 마이크 입력으로 **스피커 온도**와 **진동판 변위(excursion)**를 실시간으로 시각화합니다. 

**Teams에 공유된 SDK를 아래의 경로로 옮긴 뒤 진행해야 되며, third_party를 반드시 추가해야 패키징이 진행됩니다.**
```
./iron-Device-simulator
ㄴ--electron
        ㅏ----wasm-engine/custom
        |                    ㅏ 보호 알고리즘.h
        |                    ㄴ 보호 알고리즘.c
        ㄴ----windows
            ㄴ----third_party  # mkdir third_party 
                ㄴ---- ASIOSDK # 폴더명 일치
```

<img width="1920" height="958" alt="image" src="https://github.com/user-attachments/assets/99f08e17-383e-4aec-869f-2337b5e02ed8" />

---

## 설치

```bash
git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git
cd iron-Device-simulator
npm install
```

---

## 빠른 시작

클론 직후 원커맨드(환경 확인 → `npm install` → WASM 빌드 → dev 서버)
이후 로컬 서버를 종료해주세요. ```Ctrl + c```

```bash
npm run bootstrap
```

### 데스크톱 앱 패키징(Electron)

`build:desktop`과 동일한 정적 코어 빌드를 실행한 뒤, [electron-builder](https://www.electron.build/)로 감싸 **macOS, Windows, Linux**(`x64`, `arm64` 모두) 설치형 데스크톱 앱 6종을 `dist-electron/` 아래에 생성합니다.
```bash
npm run build:electron          # 모든 OS 패키징

npm run build:electron:linux    # only-linux(개선 예정)
npm run build:electorn:mac      # only-mac
npm run build:electron:windows  # only-windows
```

**이 빌드들은 서명되지 않았습니다**(앱스토어/공개 배포용이 아니라 팀 내부 배포용 — `electron-builder.yml` 참고). 최초 실행 시 다음 한 단계가 필요합니다.

- **macOS**: 앱을 우클릭 → 열기 (더블클릭으로 실행하면 Gatekeeper가 서명되지 않은 앱을 차단합니다)
- **Windows**: SmartScreen 경고에서 "추가 정보" → "실행" 클릭
- **Linux**: `chmod +x *.AppImage` 후 바로 실행 — 별도 경고 없음

전체 패키징 없이 미리보기만 하려면(이미 어떤 정적 빌드로든 `out/`이 만들어져 있는 상태에서):


```bash
npm run build:desktop       # 빌드
npm run electron:preview    # electron . — electron/main.js를 현재 out/ 기준으로 실행
```

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `USE_QUEUE` | `true` | `false`로 설정하면 출력 큐 스케줄러 대신 단순 FIFO 렌더 경로를 사용합니다.  |
| `USE_WORKER_ENGINE` | `1` | `0` 로 1로 설정하여 메인 스레드의 작업을 분산시켜 온전히 UI 렌더링 작업만 진행할 수 있게합니다. |


## 개발 명령어

웹에서의 동작은 배제하고 작성된 명령어로, Electron 개발 명령어이니 참고 부탁드립니다.

```bash
npm run wasm:build          # electron/native/wasm-engine/*.c를 브라우저 타깃 WASM으로 컴파일
npm run wasm:preview        # 변경된 알고리즘에 대해서만 변경 이후 electron 자동 실행해주는 명령어
npm run build:desktop       # 정적 빌드 → out/ (위 빌드 항목 참고)
npm run build:electron      # {:linux, :mac, :windows} 정적 빌드 + Electron 패키징 → out/ + dist-electron/ (위 빌드 항목 참고)
npm run electron:preview    # electron . — 현재 out/ 기준으로 electron/main.js 실행, 패키징 없음. 앱 환경에서의 빠른 확인 가능(개발할 때 주로 사용하시면 됩니다.)
```

## 기술 스택

| 분류 | 기술 |
|---|---|
| 프레임워크 | Next.js 15 (App Router) |
| UI | React 19 · Tailwind CSS |
| 차트 | Apache ECharts (echarts-for-react) |
| 파형 | wavesurfer.js |
| 분석 엔진 | Emscripten(`emcc`) — `electron/native/wasm-engine/ff_prot.c` → WebAssembly, 브라우저 타깃, 프로세스 내부 실행(서버 없음) |
| 데스크톱 패키징 | Electron + electron-builder (macOS / Windows / Linux) |


## 라이선스

전북대학교 SW 산학협력 프로젝트 — 재배포 및 공개 금지.
