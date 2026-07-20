# audio-device-helper (Windows/Linux, 계획 단계 — 아직 소스 없음)

이 폴더는 `electron/native/macos/audio-device-helper/`(Swift/CoreAudio)와 대칭을 이루는
자리다. macOS 헬퍼가 CLI 계약(`list/get/query/set/capture/play-capture`, 첫 줄 JSON 헤더 +
이후 int16 인터리브 raw PCM stdout)을 정의하며, 이 폴더는 같은 계약을 **RtAudio 기반
단일 C++ 헬퍼**로 구현해 Windows(ASIO·WASAPI)를 커버할 예정이다.

아직 코드가 없다 — 전체 설계·계약 스펙·플랫폼별 함정·빌드/패키징 절차·작업 단계 체크리스트는
**`docs/windows-plan.md`**를 단일 진실원으로 참고한다. 구현을 시작할 때 그 문서의 §2(`main.cpp`
구조), §5(플랫폼별 함정), §8(Phase 체크리스트)부터 진행하면 된다.

Linux(ALSA/JACK)도 같은 RtAudio 소스를 재사용할 계획이며, 현재는 이 `windows/` 폴더 하나로
시작한다 — 실제 Linux 빌드 착수 시 `electron/native/linux/`로 분리할지는 그때 결정한다
(`docs/windows-plan.md` §2, §5.6 참고).

## 산출물 경로 (구현 후)

```
electron/native/windows/audio-device-helper/
  main.cpp
  CMakeLists.txt
  build.ps1            # Windows (MSVC)
  build.sh             # Linux
  README.md            # 빌드/ASIO SDK 취득/제약 (이 파일을 대체)
  dist/                # 산출물 (git-ignore): audio-device-helper[.exe]
```

경로 규칙은 macOS 쪽과 대칭이라 `electron/ipc/audio-device.js`의 `AUDIO_HELPER_PATH`가
`process.platform` 분기만 넓히면 그대로 재사용된다(`docs/windows-plan.md` §3.1).
