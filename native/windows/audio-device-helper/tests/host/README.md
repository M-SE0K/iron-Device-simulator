# tests/host — Windows 없이 돌리는 검증 하네스

`main.cpp`의 새 코드(= `--stream`의 stdin 프레이밍, 프리필 게이트, 종료 시퀀스)는
Windows·ASIO SDK·MCHStreamer가 전부 있어야만 돌아간다. 그런데 이 셋이 다 갖춰진
자리에서 처음 실행해 보는 건 너무 늦다 — 프레이밍 버그는 "가끔 잡음"이나 "재생이 안
시작됨" 같은 형태로만 드러나 추적이 매우 비싸다.

그래서 두 겹을 얇게 갈아 끼워 **호스트(macOS/Linux)에서 진짜 `main.cpp`를 실행**한다:

| 갈아 끼우는 것 | 무엇으로 | 왜 |
|---|---|---|
| `windows.h` / `io.h` / `fcntl.h` | `winshim/` (POSIX 백엔드) | `Sleep`·`GetTickCount64`·`_read`·`_setmode`·COM·CLSID 스텁만 있으면 된다 |
| `asio.h` / `asiosys.h` / `asiodrivers.h` | `asiostub/` (선언만) | SDK는 재배포 금지라 리포에 없다. **타입체크 전용** — 링크하지 않는다 |
| `asio_backend.cpp` | `fake_backend.cpp` | ASIO 드라이버 대신 **bufferSwitch를 모사한 스레드**가 링을 소비/생산한다 |

두 겹은 쓰임이 다르다. `asiostub/`은 `asio_backend.cpp`를 **컴파일만** 해보는 데 쓰고
(실행하지 않는다), `fake_backend.cpp`는 `main.cpp`를 **실제로 실행**하는 데 쓴다.

```bash
./tests/host/run-stream-test.sh
```

## 무엇이 검증되고 무엇이 안 되는가

검증되는 것:

- `main.cpp`의 stdin 프레이밍 — `pcm <n>` 페이로드 경계, 한 번의 read에 여러 프레임이
  섞여 오는 경우, `end`/`pause`/`resume`/`stop` 라인
- 프리필 게이트 — 프리필 전에는 캡처도 흐르지 않는다(단일 클록 등식의 전제), `end`가
  게이트를 여는 경로, 타임아웃 → exit 4
- 종료 시퀀스 — 드레인 + 감쇠 테일 → exit 0, 언더런 stderr 집계
- `asio_backend.cpp`가 컴파일된다는 사실 (경고 포함)

검증되지 **않는** 것:

- ASIO 콜백의 실제 출력 경로 — 출력 버퍼 memset, `convert::fromFloat`이 드라이버 포맷으로
  제대로 쓰는지, `ASIOOutputReady` 타이밍. 전부 실기(MCHStreamer)에서만 확인된다.
- 진짜 드라이버의 버퍼 격자 스냅·레이턴시·리셋 요청

⚠️ `fake_backend.cpp`의 재생 로직은 진짜 `bufferSwitch`의 의미론을 **베껴 쓴 모델**이다.
둘이 어긋나면 이 테스트는 조용히 틀린 것을 통과시킨다 — 한쪽을 고치면 다른 쪽도 봐야 한다.
`asiostub/`의 `ASIOSampleType` 숫자만은 예외로, `asio_backend.cpp`의 `static_assert`가
`sample_convert.h`의 복제본과 대조하므로 어긋나면 컴파일이 실패한다.
