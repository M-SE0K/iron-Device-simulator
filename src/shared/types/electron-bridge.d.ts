// electron-bridge.d.ts — electron/preload.js가 contextBridge로 노출하는 window.audioDevice /
// window.audioCapture / window.localFolder 타입. 브라우저/개발서버에서는 모두 undefined이며
// Electron 데스크톱 빌드에서만 존재한다.
export {};

interface AudioDeviceActual {
  sampleRate: number | null;
  bufferSize: number | null;
}

// audio-device:list 항목 — 연결된 입력 장치 하나 (CoreAudio 열거). uid는 재연결에도 안정적.
export interface AudioInputDevice {
  uid: string;
  name: string;
  inputChannels: number;
  sampleRate: number | null;
  isDefault: boolean; // OS 기본 입력 장치 여부
}

interface AudioDeviceListResult {
  success: boolean;
  devices?: AudioInputDevice[];
  error?: string;
}

interface AudioDeviceConfigResult {
  success: boolean;
  device?: string;
  deviceUID?: string;
  requested?: { sampleRate: number; bufferSize: number };
  actual?: AudioDeviceActual;
  error?: string;
}

interface AudioDeviceQueryResult {
  success: boolean;
  device?: string;
  deviceUID?: string;
  current?: AudioDeviceActual;
  supportedSampleRates?: number[];
  bufferRange?: { min: number; max: number };
  inputChannels?: number;
  error?: string;
}

interface AudioCaptureStartResult {
  success: boolean;
  device?: string;
  deviceUID?: string;
  channels?: number;
  requested?: { sampleRate: number; bufferSize: number };
  actual?: AudioDeviceActual;
  error?: string;
}

export interface LocalAudioFileEntry {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

interface LocalFolderSelectResult {
  canceled: boolean;
  folderPath?: string;
  files?: LocalAudioFileEntry[];
  error?: string;
}

interface LocalFolderReadResult {
  success: boolean;
  data?: Uint8Array;
  mime?: string;
  error?: string;
}

declare global {
  interface Window {
    audioDevice?: {
      list: () => Promise<AudioDeviceListResult>;
      // deviceUID 생략 시 OS 기본 입력 장치 대상
      getConfig: (deviceUID?: string) => Promise<AudioDeviceConfigResult>;
      setConfig: (sampleRate: number, bufferSize: number, deviceUID?: string) => Promise<AudioDeviceConfigResult>;
      query: (deviceUID?: string) => Promise<AudioDeviceQueryResult>;
    };
    audioCapture?: {
      start: (opts: {
        sampleRate: number;
        bufferSize: number;
        channels?: number;
        deviceUID?: string; // 생략 시 OS 기본 입력 장치
      }) => Promise<AudioCaptureStartResult>;
      stop: () => Promise<{ success: boolean }>;
      onData: (callback: (chunk: Uint8Array) => void) => () => void;
      onEnded: (callback: (info: { code: number | null }) => void) => () => void;
    };
    localFolder?: {
      select: () => Promise<LocalFolderSelectResult>;
      unwatch: () => Promise<{ success: boolean }>;
      readFile: (filePath: string) => Promise<LocalFolderReadResult>;
      onChanged: (callback: (files: LocalAudioFileEntry[]) => void) => () => void;
    };
  }
}
