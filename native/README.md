# native

## 1. 도메인 설명

렌더러(TypeScript)만으로는 만들 수 없는 앱의 "웹 바깥" 전부, 즉 OS 오디오 하드웨어 입출력과 C 알고리즘의 WebAssembly화를 담당하는 네이티브 소스 모음입니다. 이 폴더의 4개 하위 도메인만 읽으면 하드웨어 V/I 캡처, 파일 재생, 분석 엔진 WASM, 파형 렌더 커널이 각각 어디서 오는지 알 수 있습니다. 특정 데스크톱 셸에 종속되지 않도록 리포 최상위에 있습니다 — 과거 Electron 셸과 현재 Tauri 셸이 같은 소스를 공유해 왔고 셸이 바뀌어도 이 폴더의 계약은 그대로입니다.

## 2. 프로젝트 전반에서의 역할

`src-tauri/`(Rust 셸)가 자식 프로세스로 실행하는 **오디오 헬퍼 바이너리 2종**(macOS/Windows)과 WebView 안에서 도는 **WASM 모듈 2종**(분석 엔진 ff_prot, 렌더 커널 pcm-kit)의 소스·빌드 체계가 전부 여기에 있습니다. 패키징(`scripts/build/build-tauri.sh`)은 이 폴더에서 헬퍼를 빌드해 `src-tauri/binaries/` 사이드카로 복사하고 `build-wasm.sh` 산출물(`public/wasm/`)을 정적 번들에 넣습니다. 개발 실행에서는 `src-tauri/src/helper.rs`가 이 폴더의 `dist/`를 헬퍼 폴백 경로로 직접 참조합니다.

## 3. 파일별 역할

| 폴더 | 역할 |
|------|------|
| `macos/audio-device-helper/` | macOS CoreAudio HAL 헬퍼(Swift) — `list`/`get`/`query`/`set`/`capture`/`play-capture` CLI, `mac.swift` → `dist/` 바이너리 |
| `windows/audio-device-helper/` | Windows ASIO 헬퍼(C++, mingw-w64 크로스 컴파일) — macOS 헬퍼와 같은 CLI 계약을 구현하는 형제 바이너리, 소스는 공유하지 않음. 자체 C++ 테스트(`tests/`) 보유 |
| `wasm-engine/` | ff_prot 분석 엔진의 WASM 빌드 체계 — `build-wasm.sh`(Emscripten 컴파일 + 난독화/하드닝)와 `custom/` 알고리즘 드롭인 폴더 |
| `pcm-kit/` | 렌더 계층 벌크 PCM 커널 — 파형 엔벌로프(버킷별 min/max) 집계를 WASM으로 처리. 엔진과 별개의 평문 WASM(암호화 대상 아님) |

## 4. 의존성 및 흐름

이 폴더는 앱 코드(`src/`)를 import하지 않습니다. 소비 방향은 전부 바깥 → 안쪽입니다:

```
src-tauri(Rust) ── 자식 프로세스 spawn ──→ {macos,windows}/audio-device-helper (argv in, 한 줄 JSON + raw PCM stdout)
scripts/build/build-tauri.sh ── 빌드+복사 ──→ src-tauri/binaries/audio-device-helper-<타깃 트리플>[.exe]
scripts/build/build-wasm.sh ──→ ① pcm-kit/build-pcm-kit.sh → public/wasm/pcm_kit.wasm
                                ② wasm-engine/build-wasm.sh → public/wasm/ff_prot.{js,wasm}
WebView: wasm-client.ts가 ff_prot WASM을, src/features/audio/lib/pcm-kit.ts가 pcm_kit.wasm을 로드
```

Windows 헬퍼에 필요한 Steinberg ASIO SDK 2.3은 리포에 포함돼 있지 않습니다(재배포 제한 — 별도 취득). 헬퍼 실행 파일(`dist/`, `.exe`)은 패키징 때마다 새로 빌드합니다.

## 5. 주요 인터페이스 / 진입점

이 폴더의 진입점은 코드 심볼이 아니라 **하위 도메인별 README와 계약 문서**입니다:

- `macos/audio-device-helper/README.md` — **§"명령어"가 두 헬퍼 공통 CLI 계약의 원천** (argv 인자, 한 줄 JSON stdout, 종료 코드)
- `windows/audio-device-helper/README.md` — macOS 계약과의 차이(버퍼 그리드 스냅, OS 기본 장치 부재, `uid`=드라이버 CLSID 등) 정리
- `wasm-engine/README.md` + `wasm-engine/custom/README.md` — 엔진 드롭인 계약(`ff_prot_init`/`ff_prot_set_param`/`ff_prot_start_exec`(9-인자)/`ff_prot_stop_exec` 4개 export 심볼)과 빌드/난독화 노브
- `pcm-kit/README.md` — 렌더 커널의 export 함수와 JS 폴백 관계(산출물이 없으면 앱은 느려질 뿐 깨지지 않음)

## 6. 변경 이력(요약)

- 2026-08-19: umbrella 문서로 재작성 (mse0k-domain-tw) — 이전 내용(ff_prot 참조 구현 설명 + 절단된 시그니처 표)은 `wasm-engine/README.md`에 완전판이 있어 이관 없이 교체
