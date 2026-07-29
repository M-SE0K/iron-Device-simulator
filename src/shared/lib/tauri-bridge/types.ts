// types.ts — src/shared/types/electron-bridge.d.ts에 선언돼 있지만 export되지 않은(그래서
// import로 이름을 가져올 수 없는) 결과 타입들을 shim 내부 타이핑용으로 그대로 미러링한다.
//
// electron-bridge.d.ts는 계약의 단일 소스이므로 이 파일에서는 절대 수정하지 않는다 — 대신
// window.audioDevice 등에 최종 객체를 대입할 때 TypeScript가 구조적으로 이 타입들과
// electron-bridge.d.ts의 내부 인터페이스를 비교해 검증해준다. 즉 이 파일의 필드가
// electron-bridge.d.ts와 어긋나면 index.ts의 대입문에서 타입 에러로 드러난다(그래서 안전).
import type { AudioInputDevice, LocalAudioFileEntry } from "@/shared/types/electron-bridge";

interface AudioDeviceActual {
  sampleRate: number | null;
  bufferSize: number | null;
}

export interface AudioDeviceListResult {
  success: boolean;
  devices?: AudioInputDevice[];
  error?: string;
}

export interface AudioDeviceConfigResult {
  success: boolean;
  device?: string;
  deviceUID?: string;
  requested?: { sampleRate: number; bufferSize: number };
  actual?: AudioDeviceActual;
  error?: string;
}

export interface AudioDeviceQueryResult {
  success: boolean;
  device?: string;
  deviceUID?: string;
  current?: AudioDeviceActual;
  supportedSampleRates?: number[];
  bufferRange?: { min: number; max: number };
  inputChannels?: number;
  outputChannels?: number;
  error?: string;
}

// E2E 지연 실험(N1) 전용 — mark 채널이 청크마다 보내는 벽시계 타임스탬프.
export interface AudioE2EMark {
  sentAt: number;
}

export interface AudioCaptureStartResult {
  success: boolean;
  device?: string;
  deviceUID?: string;
  channels?: number;
  requested?: { sampleRate: number; bufferSize: number };
  actual?: AudioDeviceActual;
  error?: string;
}

export interface PlayCaptureStartResult extends AudioCaptureStartResult {
  mode?: "play-capture";
  refLen?: number;
  playbackChannel?: number;
  playbackChannelR?: number | null;
}

export interface PlayCaptureWriteHandshakeResult {
  success: boolean;
  writeId?: string;
  error?: string;
}

export interface PlayCaptureWriteAckResult {
  success: boolean;
  error?: string;
}

export interface LocalFolderSelectResult {
  canceled: boolean;
  folderPath?: string;
  files?: LocalAudioFileEntry[];
  error?: string;
}

export interface LocalFolderReadResult {
  success: boolean;
  data?: Uint8Array;
  mime?: string;
  error?: string;
}
