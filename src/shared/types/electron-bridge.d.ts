// electron-bridge.d.ts — electron/preload.js가 contextBridge로 노출하는 window.audioDevice 타입.
// 브라우저/개발서버에서는 undefined이며 Electron 데스크톱 빌드에서만 존재한다.
export {};

interface AudioDeviceActual {
  sampleRate: number | null;
  bufferSize: number | null;
}

interface AudioDeviceConfigResult {
  success: boolean;
  device?: string;
  requested?: { sampleRate: number; bufferSize: number };
  actual?: AudioDeviceActual;
  error?: string;
}

declare global {
  interface Window {
    audioDevice?: {
      getConfig: () => Promise<AudioDeviceConfigResult>;
      setConfig: (sampleRate: number, bufferSize: number) => Promise<AudioDeviceConfigResult>;
    };
  }
}
