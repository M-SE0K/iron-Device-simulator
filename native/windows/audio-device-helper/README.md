# audio-device-helper — ASIO 헬퍼 (Windows 전용)

`native/macos/audio-device-helper/`(Swift/CoreAudio)와 **같은 CLI 계약을 구현하는
형제 바이너리**다. 소스는 공유하지 않는다 — 공유되는 것은 argv와 한 줄 JSON stdout뿐이고,
`src-tauri/src/audio_device.rs`가 타깃 OS로 경로만 갈라 그대로 재사용한다.
계약의 단일 진실원은 macOS 쪽 README의 "명령어" 절이다.

RtAudio를 쓰지 않고 Steinberg ASIO SDK 2.3을 직접 호출한다.

## 구현 상태

| 명령 | 상태 |
| --- | --- |
| `list` | ✅ |
| `get` | ✅ |
| `query` | ✅ |
| `set` | ⚠️ sampleRate만 실제 적용된다 (아래 참고) |
| `capture` | ✅ |
| `play-capture --ref` | ✅ |
| `play-capture --stream` | ⚠️ 구현 완료, **실기 검증 대기** (아래 참고) |

상주 모드(`capture`/`play-capture`)는 락프리 링버퍼(`ring_buffer.h`)·샘플 포맷 변환
(`sample_convert.h`)·실시간 스레드 분리가 얽혀 있어 단계를 나눠 구현했다. 실기 검증 완료:
버퍼 스냅(480→512), stdin EOF 종료, USB 분리 → exit 3, 재생 완료 자기 종료(exit 0),
pause/resume/stop 라인 명령까지 miniDSP ASIO Driver로 확인했다.

👉 **설계 배경은 아래 "구현 시 주의" 절과 `src/`의 파일별 헤더 주석**에 있다 — 실측 포맷
(`Int32LSB`), 스레드 구조, 종료 경로가 각 소스 상단 주석으로 정리돼 있다.

> ⚠️ `bufferSize`는 드라이버 격자로 **스냅된다**(예: 480 요청 → 512). 헤더의 `actual.bufferSize`가
> 실제 값이고, 렌더러는 이미 그 값을 읽어 쓴다(`useNativeCapture.ts`). macOS가 요청값을 그대로
> 쓰던 자리라 값이 달라지는 게 정상이다.

> ⚠️ **`--stream`은 아직 MCHStreamer로 돌려보지 않았다.** 호스트 하네스
> (`tests/host/run-stream-test.sh`)로 프레이밍·프리필 게이트·종료 코드·언더런 보고까지
> 검증했지만, 그 하네스는 ASIO 콜백을 가짜로 대체한다 — `bufferSwitch`의 실제 출력 경로는
> 실기에서만 확인된다. 검증 항목은 `docs/protected-playback-plan.md` §9를 볼 것.

## 빌드

**보통은 직접 부를 일이 없다** — `npm run build:tauri -- --windows`(→ `scripts/build/build-tauri.sh`)가
패키징 직전에 자동으로 호출한다. 헬퍼만 따로 빌드하려면:

```bash
./build-win.sh                          # third_party/ASIOSDK 또는 $ASIOSDK_DIR
ASIOSDK_DIR=/path/to/SDK ./build-win.sh
```

요구사항: mingw-w64 크로스 컴파일러 (`sudo apt install g++-mingw-w64-x86-64`), ASIO SDK 2.3.
산출물은 `dist/audio-device-helper.exe` 하나(x64, `-static`)다.

### 왜 MSVC가 아니라 mingw 크로스 컴파일인가

패키징(`build-tauri.sh` → tauri build)이 **WSL에서도 돌기 때문**이다(cargo-xwin 크로스 경로). MSVC를 쓰려면
소스를 Windows로 옮겨 빌드하고 산출물을 되가져와야 하는데, 그 왕복을 사람이 손으로 하는 한
**exe가 소스보다 낡은 채로 패키징되는 사고**가 반복된다. 실제로 겪었다 — capture 구현이 통째로
빠진 exe가 zip에 들어갔고, 앱에서는 `not-implemented(capture)` 에러로만 보여서 원인을 찾는 데
한참 걸렸다. 크로스 컴파일이면 패키징과 같은 호스트에서 같은 명령으로 끝나 그 틈이 사라진다.

`-static`으로 링크하므로 VC++ 재배포 패키지나 mingw 런타임 DLL에 의존하지 않는다.

> `msvc/build.ps1` / `msvc/CMakeLists.txt`는 **보조 경로**다. Windows에서 MSVC로 빌드해야 할
> 때를 위해 남겨뒀지만 패키징 파이프라인은 쓰지 않는다. 소스(`../src/`)·SDK(`../third_party/`)·
> 산출물(`../dist/`)은 모두 헬퍼 루트를 공유한다. 요구사항: Visual Studio 2019+ (C++ 데스크톱
> 워크로드), CMake 3.15+.

> `dist/`는 `.gitignore`로 제외된다 — 산출물(`audio-device-helper.exe`)은 GPLv3 ASIO SDK를
> 링크한 생성 파일이며, 패키징 시 매번
> `build-win.sh`로 새로 빌드하므로 `SKIP_WIN_HELPER_BUILD=1`로 재사용은 못 한다.
> SDK를 푸는 `third_party/`와 CMake 작업 폴더 `build-*/`도 `.gitignore`로 제외된다.

### ASIO SDK 취득

이 프로젝트는 [Steinberg의 ASIO 공개 GPLv3 배포판](https://www.steinberg.net/developers/asiosdk-open/)을
사용한다. SDK는 버전과 원문 라이선스를 빌드 환경에서 명확히 통제하기 위해 리포에 vendoring하지
않으며, 개발자 포털에서 받은 SDK를 `common\`과 `host\`가 보이도록 풀고 위 방법으로 경로를 지정한다.

SDK에서 실제로 컴파일하는 것은 세 파일뿐이다 — `common/asio.cpp`, `host/asiodrivers.cpp`,
`host/pc/asiolist.cpp`. `driver/` 밑은 ASIO 드라이버를 *만들* 때 쓰는 코드라 호스트인 우리는
**포함하면 안 된다**(`DllMain` 등이 딸려와 링크가 깨진다).

> 라이선스: 프로젝트와 Windows ASIO 헬퍼는 `GPL-3.0-only`로 배포한다. 배포 시 이 저장소의
> 대응 소스, 루트 `LICENSE`, ASIO SDK의 저작권·라이선스 고지를 함께 제공해야 한다.

### ⚠️ 비트수

64비트 헬퍼는 **64비트 ASIO 드라이버만** 보고 열 수 있다. Tauri 앱의 기본 빌드 타깃이
x64(`x86_64-pc-windows-msvc`)이므로 기본값 `x64`를 유지한다. 32비트 드라이버만 설치된
장치는 목록에 아예 나타나지 않는다.

## 실측값 (miniDSP ASIO Driver / MCHStreamer)

`query` 실제 출력. 다른 하드웨어를 붙일 때 비교 기준으로 쓴다.

```json
{
  "device": "miniDSP ASIO Driver",
  "deviceUID": "{466A3ACF-0324-46F9-9A38-FB08FFDD208E}",
  "current": { "sampleRate": 48000, "bufferSize": 16 },
  "supportedSampleRates": [8000,11025,16000,32000,44100,48000,88200,96000,176400,192000],
  "bufferRange": { "min": 8, "max": 2048 },
  "inputChannels": 8, "outputChannels": 8,
  "bufferPreferred": 16, "bufferGranularity": -1,
  "latency": { "input": 88, "output": 168 }
}
```

읽을 점 세 가지:

- **`bufferGranularity: -1`** → 2의 거듭제곱만 허용. macOS가 쓰던 480은 **512로 스냅**된다
  (`set 48000 480` → `actual.bufferSize: 512` 실측 확인).
- **`bufferPreferred: 16`** 이라 `current.bufferSize`가 16으로 보인다. ASIO엔 "현재 버퍼
  크기"가 없어 preferred를 대신 싣기 때문이다 — macOS가 512를 보여주던 자리라 UI에서
  혼란스러울 수 있다.
- **384000이 없다.** macOS CoreAudio에서는 MCHStreamer가 384kHz까지 노출했지만 ASIO
  드라이버는 192kHz까지만 신고한다. 같은 하드웨어라도 드라이버가 다르면 능력이 다르다.

## macOS(CoreAudio)와 갈리는 지점

계약은 같지만 OS 모델이 달라 의미가 어긋나는 곳이 있다. 키를 지우지 않고 **가산**만 했으므로
기존 렌더러 코드는 그대로 동작한다.

### 1. `set`은 sampleRate만 적용한다 — `"applied": { ... }`

두 값의 성격이 달라 응답에서 각각 보고한다.

```json
"applied": { "sampleRate": true, "bufferSize": false }
```

- **sampleRate** — `ASIOSetSampleRate`로 드라이버에 실제 적용된다. miniDSP ASIO 드라이버에서
  `set 44100` 후 별도 프로세스의 `get`이 44100을 읽는 것까지 실측 확인했다. **macOS와 동일한
  거동이다.** 다만 지속성은 ASIO 스펙이 보장하지 않는 드라이버 재량이라, 다른 하드웨어에서는
  다를 수 있다.
- **bufferSize** — 적용되지 않는다. ASIO는 `ASIOCreateBuffers` 시점에만 크기가 정해지므로
  `set`이 건드릴 대상 자체가 없다. `actual.bufferSize`는 "`capture`가 이 값을 요청하면 실제로
  무엇이 될지"를 미리 계산해 보여주는 값이다.

결론적으로 macOS와 같다 — SampleRate는 유지되고 BufferSize의 실제 적용 지점은 `capture`다.

### 2. "기본 장치" 개념이 없다

ASIO에는 OS 기본 입력 장치가 없다. `--device`를 생략하면 **레지스트리 첫 번째 드라이버**를
쓰고, `list`는 그 항목에만 `isDefault: true`를 붙인다. 앱에 이미 장치 드롭다운이 있어
실질 영향은 작다.

### 3. 버퍼 크기가 자유값이 아니다 — 클램프가 아니라 격자 스냅

`ASIOGetBufferSize`가 돌려주는 `granularity`가

- `-1` → **2의 거듭제곱만** 허용
- `> 0` → `min + k*granularity`만 허용

CoreAudio처럼 범위 클램프만 하면 드라이버가 거부한다. 헬퍼가 격자에 스냅한 뒤 `actual`에
진짜 값을 싣는다 — macOS에서 480이 그대로 먹던 것이 ASIO에선 512로 바뀔 수 있다.

`query`가 `bufferPreferred`/`bufferGranularity`를 추가로 내보내므로, UI가 임의 버퍼 크기
입력을 막는 신호로 쓸 수 있다.

분석 파이프라인은 영향받지 않는다 — 렌더러(`reframeNativeChunk.ts`)가 바이트 스트림에서
`frameBytes()` = `samplesPerCh × 2ch × int16`(기본 480 samples → **1920바이트**) 프레임을
재조립하므로 콜백 크기가 512여도 무방하다. 청크 경계에 걸친 잔여 바이트와 미완성 프레임을
각각 이월하므로 512 → 480 재조립에서 유실이 없다.

### 4. `list`의 `probed` 키

ASIO는 **드라이버를 열어야만** 채널 수와 샘플레이트를 알 수 있는데, 열기는 배타적이라
실패할 수 있다(특히 우리 자신의 `capture` 프로세스가 그 장치를 쥐고 있을 때).

실패해도 장치를 목록에서 빼지 않는다 — 드롭다운에서 사라지면 선택 자체가 불가능해지기
때문이다. 대신 `inputChannels: 0`, `sampleRate: null`, `"probed": false`로 표시한다.
빠른 열거가 필요하면 `list --no-probe`.

> 렌더러 `CalibrationDrawer.tsx`는 힌트를 `${d.inputChannels}ch`로 찍으므로 `probed:false`인
> 장치는 "0ch"로 보인다. `probed`를 보고 "—ch"로 바꾸는 건 별도 작업으로 남겨둔다.

### 5. `uid`는 CLSID 문자열

macOS는 CoreAudio UID를, Windows는 **드라이버 CLSID**(`"{...}"`)를 `uid`로 쓴다. 이름은
중복·변경 가능성이 있지만 CLSID는 레지스트리의 진짜 키라 재연결에도 안정적이다.

### 6. `play-capture --stream` — 재생 소스가 파일이 아니라 stdin

macOS와 **계약은 같고 구현만 다르다**. 보호 재생(`docs/protected-playback-plan.md`)에서
스피커로 나가는 신호는 렌더러가 `ff_prot`을 통과시킨 결과라, 재생을 시작하기 전에 파일로
가지고 있을 수가 없다 — 재생해야 V/I가 생기고, V/I가 있어야 다음 프레임을 처리한다.
그래서 `--ref`(파일 선업로드) 대신 stdin으로 계속 받는다.

```
audio-device-helper play-capture --stream [--device <UID>] [--prefill-ms <n>]
    [--prefill-timeout-s <n>] [--out-ch <n>] [--out-ch-r <n>]
    <sampleRate> <bufferSize> [channels=2]
```

stdin 프레이밍 (macOS와 동일):

```
"pcm <nBytes>\n" + <nBytes 그대로>   # int16 인터리브 스테레오 LE
"end\n"                              # 더 보낼 프레임 없음 → 링 소진 + 0.25s 테일 후 exit 0
"pause\n" / "resume\n" / "stop\n"    # 기존 라인 명령 그대로
```

헤더도 `--ref`와 갈린다 — 길이를 아직 모르므로 `refLen` 대신 `prefillFrames`가 실린다:

```json
{"success":true, ..., "mode":"play-capture-stream", "prefillFrames":1920,
 "playbackChannel":0, "playbackChannelR":1}
```

ASIO 쪽에서 새로 생기는 것은 **`ASIOStart`를 미룬다**는 점 하나다. 링이 빈 채로 시작하면
앞머리가 통째로 무음이 되는데 캡처는 그 구간까지 세므로, 렌더러가 재생 위치의 근거로 삼는
"수신 캡처 프레임 수 = 재생 프레임 수" 등식이 깨진다. 그래서 프리필(기본 40 ms)이 찰 때까지
기다렸다가 시작하고, `--prefill-timeout-s`(기본 15초) 안에 못 차면 **exit 4**로 끝낸다.

버퍼 격자 스냅은 이 모드에서 추가 고려 사항이 아니다 — 링이 프레임 단위이고 `pcm` 프레이밍이
임의 바이트 수를 받으므로, 콜백 크기가 480이든 512든 재조립이 필요 없다.

언더런(렌더러가 못 따라와 링이 마름)은 **무음을 내보내되 읽기 위치를 소비하지 않는다** —
샘플을 버리는 게 아니라 재생을 뒤로 미룬다. 누적량은 종료 시 stderr에 남는다.

## 파일 구조

```
src/
  main.cpp          CLI 계약 — argv 파싱, JSON 출력, 종료 코드, writer/stdin 스레드
  audio_backend.h   장치 접근 추상 경계
  asio_backend.cpp  ASIO 구현 (DriverSession RAII, 레지스트리 열거, 능력 조회, 상주 스트림)
  json_out.h        의존성 없는 최소 JSON 직렬화기
  ring_buffer.h     락프리 SPSC 링버퍼 — RT 스레드 → writer 스레드 (캡처 방향)
  playback_ring.h   락프리 SPSC 재생 링 — stdin 스레드 → RT 스레드 (--stream 전용, 반대 방향)
  sample_convert.h  ASIOSampleType ↔ int16/float 변환 (asio.h 비의존 → WSL/macOS에서 단위 테스트 가능)
tests/
  run-tests.sh            단위 테스트 — ring_buffer / playback_ring / sample_convert (ASan+UBSan, TSan)
  ring_and_convert_test.cpp
  host/                   Windows·SDK·하드웨어 없이 헬퍼를 돌려보는 하네스 (host/README.md)
    run-stream-test.sh      ★ asio_backend.cpp 타입체크 + --stream 프로토콜 시나리오
    winshim/ asiostub/      Win32 / ASIO SDK 스텁 (타입체크·실행 전용, 빌드에는 안 들어간다)
    fake_backend.cpp        ASIO 대신 bufferSwitch를 모사하는 가짜 백엔드
    stream_test.py          시나리오 정의
build-win.sh        ★ 정식 빌드 — mingw-w64 크로스 컴파일 (src/ → dist/audio-device-helper.exe)
msvc/
  CMakeLists.txt    보조 — Windows/MSVC 빌드용
  build.ps1         보조 — Windows/MSVC 빌드용
dist/               산출물 audio-device-helper.exe (라이선스 이슈로 .gitignore)
```

ASIO를 `src/asio_backend.cpp`에 격리해 둔 이유는, ASIO 드라이버가 설치되지 않은 Windows PC가
실사용에서 흔하기 때문이다 — WASAPI 폴백이 필요해지면 `src/wasapi_backend.cpp` 추가로 끝난다.

## 구현 시 주의 (상주 모드 착수 전 읽을 것)

1. **`bufferSwitch` 콜백에서 stdout에 쓰면 안 된다.** 드라이버의 실시간 스레드라 파이프가
   찰 때 블로킹되어 드롭아웃이 난다. 락프리 SPSC 링버퍼 + 별도 writer 스레드가 필수다.
   ASIO 드라이버는 CoreAudio보다 훨씬 덜 관대하다.
2. **샘플 포맷 변환이 새 코드다.** CoreAudio는 항상 Float32를 주지만 ASIO는 드라이버 네이티브
   포맷을 그대로 준다 — `ASIOSTInt32LSB`, `ASIOSTInt24LSB`(3바이트 패킹), `ASIOSTFloat32LSB`,
   `ASIOSTInt32LSB24` 정도면 대부분 커버되고 24비트 패킹이 유일하게 까다롭다.
3. **콜백에 user data 포인터가 없다.** ASIO 콜백은 컨텍스트 인자가 없어 상태를 파일 스코프
   싱글톤에 둬야 한다. COM 아파트먼트 제약(`ASIOInit`한 스레드에서 `ASIOExit`)과 겹치므로
   "메인 스레드가 드라이버 소유, writer 스레드는 링버퍼만 소비"로 고정한다.
4. **장치 분리 → `exit 3`.** CoreAudio의 `DeviceIsAlive` 리스너에 대응하는 것은
   `asioMessage`의 `kAsioResetRequest`다. 부모/렌더러가 code 3을 "장치 연결이 끊겼습니다"로
   구분하므로 이 매핑을 반드시 지켜야 한다.
5. **일회성 명령은 실패해도 exit 0.** 부모가 `execFile`을 쓰기 때문에 종료 코드가 0이 아니면
   stdout의 `{"success":false,"error":"..."}`를 버리고 "Command failed"로 덮어쓴다.
   사유는 항상 JSON으로 전달한다. (상주 모드의 `exit 3` 규약은 이와 별개다.)
