# macOS 수동 검증 체크리스트

`npm run verify:docker` 는 Linux 컨테이너에서 돌기 때문에 macOS 경로를 전혀 보지
못한다. 알고리즘팀에 macOS 사용자가 있으므로, **프로덕션 브랜치에 올리기 전 Mac 에서
아래를 한 번 수행한다.**

Docker 검증과 같은 원칙을 지킨다: **로컬 리포에서 하지 말고, 새로 클론한 사본에서 한다.**
로컬에는 `.wasm-seed`, `public/wasm/`, 헬퍼 `dist/` 가 이미 있어서 빠진 파일이
드러나지 않는다.

---

## 0. 클린 클론 준비

```bash
cd /tmp && rm -rf verify-mac && mkdir verify-mac && cd verify-mac
# 프로덕션에 올리기 전이라면 로컬 브랜치를 그대로 떠서 쓴다
git -C ~/path/to/iron-Device-simulater archive --format=tar HEAD | tar -x
# (원격 검증이라면) git clone https://github.com/JBNU-CILAB/Iron-Device-Simulator.git .
```

`git archive` 를 쓰는 이유는 `docker/verify/run.sh` 와 같다 — tracked 파일만 들어온다.

- [ ] 클론에 `native/wasm-engine/ff_prot.c` / `ff_prot.h` 가 **없음**을 확인
      (있으면 알고리즘 소스를 커밋 중이라는 뜻)
- [ ] `native/wasm-engine/.wasm-seed`, `src-tauri/src/wasm_key.rs` 가 **없음**을 확인

---

## 1. 환경 세팅 스크립트

```bash
bash scripts/setup/setup-macos.sh
```

- [ ] 스크립트가 에러 없이 끝난다
- [ ] `node -v` 가 20 이상
- [ ] `emcc --version` 이 동작
- [ ] `java -version` 이 동작 (하드닝 빌드의 `--closure 1` 에 필요)
- [ ] `xcode-select -p` 가 유효 (swiftc 필요)

> ⚠️ Docker 쪽 L1 에서 `setup-wsl.sh` 가 **알고리즘 소스 없이 실행하면 실패**하는
> 문제가 확인됐다면(마지막 단계에서 `npm run build:wasm` 를 조건 없이 호출),
> `setup-macos.sh` 도 같은 구조인지 함께 확인할 것.

---

## 2. 온보딩 (소스 없는 상태)

```bash
BOOTSTRAP_NO_DEV=1 npm run bootstrap
```

- [ ] **실패하지 않고** 종료된다 (exit 0)
- [ ] `native/wasm-engine/custom/` 에 무엇을 넣어야 하는지 안내가 출력된다
- [ ] `node_modules/` 가 생성됐다
- [ ] `public/wasm/` 은 생기지 않았다 (소스가 없으므로 정상)

---

## 3. 알고리즘 드롭인 → WASM 빌드

```bash
cp <리포>/docker/verify/fixtures/custom-algo/dummy_algo.c native/wasm-engine/custom/
npm run build:wasm -- --dev
```

- [ ] 빌드 성공, `public/wasm/ff_prot.{js,wasm}` 생성
- [ ] export 심볼 확인:
      ```bash
      node -e 'const m=new WebAssembly.Module(require("fs").readFileSync("public/wasm/ff_prot.wasm"));
        console.log(WebAssembly.Module.exports(m).map(e=>e.name).filter(n=>n.startsWith("ff_prot")))'
      ```
      → `ff_prot_init`, `ff_prot_set_param`, `ff_prot_start_exec`, `ff_prot_stop_exec` 4개

---

## 4. CoreAudio 헬퍼 — **Docker 로 검증 불가한 핵심 구간**

```bash
./native/macos/audio-device-helper/build-mac.sh
```

- [ ] 빌드 성공, `native/macos/audio-device-helper/dist/audio-device-helper` 생성
- [ ] universal 바이너리 확인: `lipo -info dist/audio-device-helper`
      → `arm64 x86_64` 둘 다
- [ ] 장치 열거 동작: `./dist/audio-device-helper list`
      → 한 줄 JSON, 연결된 입력 장치 목록

---

## 5. macOS 패키징

```bash
npm run build:tauri -- --mac
```

- [ ] 빌드 성공, `dist-tauri/mac/` 에 `.dmg` + `.app`
- [ ] 빌드가 `native/wasm-engine/.wasm-seed` 와 `src-tauri/src/wasm_key.rs` 를
      **스스로 생성**했다 (신규 클론에는 없던 파일)
- [ ] `src-tauri/resources/ff_prot.wasm.enc` 생성
- [ ] **평문 WASM 이 번들에 없다**:
      ```bash
      find dist-tauri/mac -name 'ff_prot.wasm'    # 결과가 없어야 정상
      find dist-tauri/mac -name 'ff_prot.js'      # 글루는 남는 게 정상
      ```
- [ ] 오디오 입력 entitlement 검증 단계가 통과했다 (빌드 스크립트가 자동 확인 —
      실패 시 빌드가 서지, 조용히 넘어가지 않음)

---

## 6. 실기 동작 — 하드웨어 필요

MCHStreamer 등 입력+출력을 모두 가진 장치를 연결한 상태에서:

- [ ] `.app` 실행, 첫 실행 시 마이크 권한 프롬프트가 뜬다
- [ ] Calibration 드로어의 **Capture Device** 목록에 장치가 보인다
- [ ] "연결된 장치" 패널에 SampleRate/BufferFrameSize/출력 채널이 표시된다
- [ ] 오디오 파일 재생 시 온도/변위 차트가 갱신된다
- [ ] Workspace 저장 후 "채널" 뷰에서 ch0(V)/ch1(I) 파형이 **전부 0이 아니다**
      → 전부 0이면 entitlement 문제다 (에러 없이 무음으로만 나타남)

---

## 7. 배포 하드닝

- [ ] 배포 빌드(`--devtools` 없이)에서 `Cmd+Opt+I` 로 DevTools 가 열리지 않는다
- [ ] 우클릭 컨텍스트 메뉴가 차단된다 (입력 필드/텍스트 선택 시는 예외)
