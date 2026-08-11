# native

## 1. 도메인 설명

브라우저 API로는 닿을 수 없는 일이 있다. 그 일을 대신하는 네이티브 소스를 모아둔 곳이다. 개발자는 이 폴더만 보고도 "장치 제어와 V/I 캡처는 어느 바이너리가 하는지", "분석 엔진 C 소스는 어디 있고 어떻게 WASM이 되는지"를 찾아갈 수 있다.

하위 도메인은 세 개다. `macos/audio-device-helper`와 `windows/audio-device-helper`는 같은 CLI 계약을 구현하는 형제 바이너리이고(소스는 공유하지 않는다), `wasm-engine`은 보호 알고리즘 C 소스를 브라우저 타깃 WASM으로 컴파일하는 빌드 루트다. 폴더마다 자기 README가 있으니 이 문서는 어디로 갈지만 가리킨다.

이 폴더는 특정 데스크톱 셸에 종속되지 않는다. 지금은 Tauri 하나가 소비하지만 소스 자체는 셸을 갈아도 그대로 쓸 수 있게 최상위에 두었다.

## 2. 프로젝트 전반에서의 역할

두 갈래로 앱에 연결된다.

- **오디오 헬퍼**(`macos/`, `windows/`) — `src-tauri/src/helper.rs`가 자식 프로세스로 실행하는 컴파일된 CLI다. Web Audio API와 `getUserMedia`로는 CoreAudio HAL 프로퍼티(NominalSampleRate·BufferFrameSize)나 ASIO 드라이버에 접근할 방법이 없어서 별도 바이너리가 그 다리 역할을 한다. 패키징 때는 `bundle.externalBin` 사이드카로 번들되고 개발 중에는 각 폴더의 `dist/`에서 찾는다.
- **WASM 엔진**(`wasm-engine/`) — `build-wasm.sh`가 C 소스를 Emscripten으로 컴파일해 `public/wasm/ff_prot.{js,wasm}`을 만들고 `lib/engine/adapters/wasm-client.ts`가 WebView 안에서 그 모듈을 직접 인스턴스화한다. `.so`/koffi FFI 로딩 경로는 쓰지 않는다.

Linux는 패키징 타깃만 있고 **네이티브 헬퍼가 없다** — 장치 제어와 하드웨어 캡처를 쓸 수 없다. WASM 엔진은 플랫폼과 무관하게 동작한다.

## 3. 파일별 역할

| 경로 | 역할 |
|------|------|
| `macos/audio-device-helper/` | macOS CoreAudio HAL 헬퍼(Swift). `src/mac.swift`가 `list`/`get`/`query`/`set`/`capture`/`play-capture`를 구현하고, `src/query-device.c`는 앱이 쓰지 않는 개발용 장치 능력 진단 CLI다. `build-mac.sh`가 arm64·x64를 각각 컴파일한 뒤 `lipo`로 합쳐 universal binary를 만든다 |
| `windows/audio-device-helper/` | Windows ASIO 헬퍼(C++). `src/main.cpp`(CLI 계약)와 `src/asio_backend.cpp`(드라이버 접근)에 링버퍼·샘플 변환 헤더가 붙는다. `build-win.sh`는 mingw-w64 크로스 컴파일, `msvc/`는 Windows에서 직접 빌드할 때 쓰는 대안 경로다. `tests/`에 자체 검증 하네스가 있다 |
| `wasm-engine/` | 보호 알고리즘 C 소스와 WASM 빌드. `build-wasm.sh`(컴파일 + 상수 난독화 + 암호화 스테이징), `custom/`(본인 알고리즘 드롭인 폴더), `obfuscate-wasm-consts.js`(산출물 후처리), `Makefile`(순수 C 셀프테스트), `.wasm-seed`(암호화 시드) |
| `README.md` | 이 문서 — 세 하위 도메인으로 가는 인덱스 |

각 하위 폴더의 상세는 그쪽 README에 있다.

- `macos/audio-device-helper/README.md` — **CLI 계약의 단일 진실원**이다("명령어" 절). 두 헬퍼가 공유하는 argv·JSON 규약, `capture`/`play-capture`/`play-capture --stream` 프로토콜, `set`의 한계, 마이크 권한(TCC)까지 여기 있다.
- `windows/audio-device-helper/README.md` — 구현 상태 표와 macOS와 갈리는 지점(버퍼 격자 스냅, OS 기본 장치 개념 없음, `uid` = 드라이버 CLSID)을 담는다.
- `windows/audio-device-helper/tests/host/README.md` — Windows·ASIO SDK·하드웨어 없이 `--stream` 프로토콜을 검증하는 하네스가 무엇을 덮고 무엇을 못 덮는지 정리한다.
- `wasm-engine/README.md` — `ff_prot.h`의 4개 함수 계약, 9-인자 `ff_prot_start_exec` 시그니처, 물리 모델 3-pass 요약, 단위 주의사항.
- `wasm-engine/custom/README.md` — 본인 C 알고리즘을 드롭인하는 절차와 래퍼 예시.

## 4. 의존성 및 흐름

- **가져오는 것**: 없다. 이 폴더의 소스는 앱 코드를 참조하지 않는다. 대신 플랫폼 SDK에 의존한다 — macOS는 CoreAudio/Swift 툴체인, Windows는 Steinberg ASIO SDK 2.3(**저장소에 포함하지 않는다**, 재배포 제약이 있어 별도로 받아야 한다), WASM은 Emscripten(`emcc`가 없으면 `build-wasm.sh`가 Docker 이미지로 자동 폴백).
- **소비하는 쪽**:
  - `src-tauri/src/helper.rs` — 헬퍼 바이너리 경로 해석(패키징: 실행 파일 옆 사이드카, 개발: `native/<os>/audio-device-helper/dist/`)과 지원 플랫폼 판정. `audio_device.rs`/`audio_capture.rs`/`audio_playcapture.rs`가 이를 재사용한다.
  - `src/features/audio/lib/engine/adapters/wasm-client.ts` — `public/wasm/ff_prot.js` 글루를 통해 WASM 모듈을 인스턴스화하고 `ff_prot_*`를 호출한다.
  - `scripts/build/build-tauri.sh` — 패키징 전에 플랫폼 헬퍼를 빌드해 `src-tauri/binaries/audio-device-helper-<타깃 트리플>[.exe]`로 복사한다. ⚠️ Windows 크로스 컴파일이 실패하면 **빌드 전체를 실패시킨다** — 커밋된 낡은 `.exe`를 모르고 패키징하는 사고를 막으려는 것이다(툴체인이 없을 때는 `SKIP_WIN_HELPER_BUILD=1`로 명시적으로 넘긴다).

```
[헬퍼 경로]
build-tauri.sh → build-mac.sh / build-win.sh → dist/audio-device-helper[.exe]
    → src-tauri/binaries/ 사이드카 복사 → tauri build
런타임: helper.rs가 경로 해석 → 자식 프로세스 실행 → argv 입력 / 한 줄 JSON stdout
    → (상주 모드) 이후 raw PCM을 stdout으로 계속 흘림 → streaming.rs가 Channel로 중계

[WASM 경로]
build-wasm.sh → emcc 컴파일 → obfuscate-wasm-consts.js(산출물 상수 난독화)
    → public/wasm/ff_prot.{js,wasm} → (기본) stage-encrypted-wasm.sh로 암호화 스테이징
런타임: wasm-client.ts가 WebView 안에서 인스턴스화 → ff_prot_start_exec 호출
```

## 5. 주요 인터페이스 / 진입점

- **헬퍼 CLI 계약** — `audio-device-helper <list|get|query|set|capture|play-capture> [--device <UID>] …`. 입력은 argv, 출력은 **stdout 한 줄 JSON**이다. `list`를 뺀 모든 명령이 `--device <UID>`를 받고, 생략하면 macOS는 OS 기본 입력 장치, Windows는 레지스트리 첫 드라이버를 쓴다(ASIO에는 OS 기본이라는 개념이 없다). 상주 모드(`capture`/`play-capture`)는 첫 줄 JSON 헤더를 낸 뒤 raw PCM을 계속 흘린다. 종료 코드는 `0`=정상/재생 완료, `3`=장치 연결 해제, `4`=`--stream` 프리필 대기 포기다. 전체 규약은 macOS README의 "명령어" 절을 본다.
- **`build-mac.sh`** — Darwin 호스트 전용. universal binary 하나를 aarch64·x86_64 두 사이드카 트리플 이름으로 복사해 Tauri의 요구를 동시에 만족시킨다.
- **`build-win.sh`** — mingw-w64 크로스 컴파일이라 macOS/Linux/WSL 호스트에서도 돌아간다. ASIO SDK의 `driver/` 소스는 링크하면 안 되고 `common/asio.cpp` + `host/asiodrivers.cpp` + `host/pc/asiolist.cpp`만 컴파일한다.
- **`build-wasm.sh`** — `selftest` 계열을 뺀 폴더 내 모든 `*.c`를 컴파일한다(정품 다중 소스 드롭인 대비). `custom/`에 `.c`가 하나라도 있으면 상위 스텁 대신 그쪽만 쓴다. 특정 파일만 지정하려면 `FF_PROT_SRCS="a.c b.c"`.
- **Windows 헬퍼 자체 검증** — 호스트 무관하게 돌아간다(Windows·ASIO SDK·하드웨어 모두 불필요).
  ```bash
  cd native/windows/audio-device-helper
  ./tests/run-tests.sh              # ring_buffer / playback_ring / sample_convert (ASan+UBSan, TSan)
  ./tests/host/run-stream-test.sh   # asio_backend.cpp 타입체크 + play-capture --stream 프로토콜 시나리오
  ```
- **`Makefile`** — 앱과 무관한 순수 C 검증용. `make selftest`로 물리 모델만 따로 돌려본다(Linux x86-64).

⚠️ `wasm-engine`의 `ff_prot.c`는 **정품이 아니다.** Iron Device 정품 `libirontune.so`의 원본 소스를 아직 받지 못해 시그니처만 맞춘 물리 근사 모델이며, 저장소에 올리지 않는다(`.gitignore`). 출력을 그라운드 트루스로 믿기 전에 `wasm-engine/README.md`를 먼저 읽는다.

## 6. 변경 이력(요약)

- 2026-08-11: 상위 인덱스로 재작성했다. 이전 문서는 `native/`를 "ff_prot 참조 구현 폴더"로 소개하고 함수 시그니처 표까지 담았다. 그 내용은 이미 `wasm-engine/README.md`에 있고 `native/` 아래에는 `macos/`·`windows/`·`wasm-engine/` 세 하위 도메인이 나란히 있어서 서로 모순됐다. 지금은 세 하위 도메인의 책임과 각자의 README 위치를 가리키는 인덱스 역할만 한다. 전체 재작성 (기준: 작업 트리, 커밋되지 않은 변경 포함)
