// audio-device.ts — window.audioDevice 브리지. 과거 Electron IPC 모듈(electron/ipc/audio-device.js,
// 현재는 제거됨)을 Rust audio_device.rs가 1:1 포팅한 4개 커맨드를 그대로 호출만 한다.
// getConfig/setConfig는 렌더러 미사용(죽은 표면)이지만 d.ts 계약 유지를 위해 구현한다.
import { COMMANDS, ARG_KEYS } from "./contract";
import { safeInvoke } from "./safe-invoke";
import type { AudioDeviceConfigResult, AudioDeviceListResult, AudioDeviceQueryResult } from "./types";

export function createAudioDeviceBridge(): NonNullable<Window["audioDevice"]> {
  return {
    // 연결된 입력 장치 전체 열거 — 장치 선택 드롭다운용
    list: () => safeInvoke<AudioDeviceListResult>(COMMANDS.audioDeviceList),

    // deviceUID를 넘기면 그 장치, 생략하면 OS 기본 입력을 대상으로 한다.
    // Rust는 `opts: Option<Value>` 단일 파라미터로 받으므로 opts 객체로 중첩해 보낸다
    // (Electron preload가 `{ deviceUID }` 객체 하나를 넘기던 wire 원형과 동일 — contract.ts 참조).
    getConfig: (deviceUID) =>
      safeInvoke<AudioDeviceConfigResult>(COMMANDS.audioDeviceGetConfig, {
        [ARG_KEYS.opts]: { [ARG_KEYS.deviceUID]: deviceUID },
      }),

    setConfig: (sampleRate, bufferSize, deviceUID) =>
      safeInvoke<AudioDeviceConfigResult>(COMMANDS.audioDeviceSetConfig, {
        [ARG_KEYS.opts]: {
          [ARG_KEYS.sampleRate]: sampleRate,
          [ARG_KEYS.bufferSize]: bufferSize,
          [ARG_KEYS.deviceUID]: deviceUID,
        },
      }),

    query: (deviceUID) =>
      safeInvoke<AudioDeviceQueryResult>(COMMANDS.audioDeviceQuery, {
        [ARG_KEYS.opts]: { [ARG_KEYS.deviceUID]: deviceUID },
      }),
  };
}
