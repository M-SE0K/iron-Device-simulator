export {};

export interface AudioDeviceActual {
  sampleRate: number | null;
  bufferSize: number | null;
}

export interface AudioInputDevice {
  uid: string;
  name: string;
  inputChannels: number;
  sampleRate: number | null;
  isDefault: boolean;
  probed?: boolean;
}

export interface AudioDeviceListResult {
  success: boolean;
  devices?: AudioInputDevice[];
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

export interface AudioCaptureStartResult {
  success: boolean;
  device?: string;
  deviceUID?: string;
  channels?: number;
  requested?: { sampleRate: number; bufferSize: number };
  actual?: AudioDeviceActual;
  error?: string;
}

interface PlayCaptureStartOpts {
  sampleRate: number;
  bufferSize: number;
  channels?: number;
  deviceUID?: string;
  refWriteId?: string;
  refChannels?: 1 | 2;
  outputChannel?: number;
  outputChannelR?: number;
  stream?: boolean;
  prefillMs?: number;
}

interface PlayCaptureStartWriteOpts {
  totalBytes: number;
}
export interface PlayCaptureWriteHandshakeResult {
  success: boolean;
  writeId?: string;
  error?: string;
}
interface PlayCaptureWriteChunkOpts {
  writeId: string;
  chunk: Uint8Array;
}
interface PlayCaptureWriteIdOpts {
  writeId: string;
}
export interface PlayCaptureWriteAckResult {
  success: boolean;
  error?: string;
}

export interface PlayCaptureStartResult extends AudioCaptureStartResult {
  mode?: "play-capture" | "play-capture-stream";
  refLen?: number;
  prefillFrames?: number;
  playbackChannel?: number;
  playbackChannelR?: number | null;
}

export interface LocalAudioFileEntry {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
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

declare global {
  interface Window {
    audioDevice?: {
      list: () => Promise<AudioDeviceListResult>;
      query: (deviceUID?: string) => Promise<AudioDeviceQueryResult>;
    };
    audioCapture?: {
      start: (opts: {
        sampleRate: number;
        bufferSize: number;
        channels?: number;
        deviceUID?: string;
      }) => Promise<AudioCaptureStartResult>;
      stop: () => Promise<{ success: boolean }>;
      onData: (callback: (chunk: Uint8Array) => void) => () => void;
      onEnded: (callback: (info: { code: number | null }) => void) => () => void;
    };
    audioPlayCapture?: {
      startWrite: (opts: PlayCaptureStartWriteOpts) => Promise<PlayCaptureWriteHandshakeResult>;
      writeChunk: (opts: PlayCaptureWriteChunkOpts) => Promise<PlayCaptureWriteAckResult>;
      finalizeWrite: (opts: PlayCaptureWriteIdOpts) => Promise<PlayCaptureWriteAckResult>;
      cancelWrite: (opts: PlayCaptureWriteIdOpts) => Promise<PlayCaptureWriteAckResult>;
      start: (opts: PlayCaptureStartOpts) => Promise<PlayCaptureStartResult>;
      writePcm: (pcm: Int16Array) => Promise<PlayCaptureWriteAckResult>;
      control: (action: "pause" | "resume" | "end") => Promise<{ success: boolean; error?: string }>;
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
    wasmAsset?: {
      loadEngineBinary: () => Promise<Uint8Array<ArrayBuffer>>;
    };
  }
}
