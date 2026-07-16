// electron-bridge.d.ts — electron/preload.js가 contextBridge로 노출하는 window.audioDevice / window.audioCapture / window.localFolder 타입. 브라우저/개발서버에서는 모두 undefined이며 Electron 데스크톱 빌드에서만 존재한다.
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
  outputChannels?: number; // 0이면 입력 전용 — play-capture(파일 재생) 불가
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

// audio-playcapture:start 옵션 — 파일 재생 + 캡처 (mac.swift runPlayCapture 참조)
interface PlayCaptureStartOpts {
  sampleRate: number;
  bufferSize: number;
  channels?: number;
  deviceUID?: string; // 생략 시 OS 기본 입력 — 단, play-capture는 입출력 겸용 장치 필요
  refWriteId: string; // finalizeWrite로 완성해둔 ref 파일(요청 SR·mono Float32)의 writeId
  outputChannel?: number; // ref를 내보낼 출력 채널 인덱스 — 생략/0이면 ch0(기본). 장치 outputChannels 범위 밖이면 헬퍼가 에러.
}

// 청크 핸드셰이크 — 재생할 파일 PCM을 한 번의 구조화 복제로 넘기지 않고 작은 조각으로
// 순차 전송한다(메인 프로세스가 동기 파일쓰기로 멎는 것을 피하려는 목적).
interface PlayCaptureStartWriteOpts {
  totalBytes: number;
}
interface PlayCaptureWriteHandshakeResult {
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
interface PlayCaptureWriteAckResult {
  success: boolean;
  error?: string;
}

// play-capture 헤더 = capture 헤더 + 재생 메타 (mode/refLen/playbackChannel)
interface PlayCaptureStartResult extends AudioCaptureStartResult {
  mode?: "play-capture";
  refLen?: number; // 재생 총 프레임 수 (테일 제외)
  playbackChannel?: number; // ref가 실제로 나간 출력 채널 — start opts의 outputChannel 요청값을 헬퍼가 그대로 echo
}

// audio-loopback:measure — duplex 헬퍼 1회 실행 헤더(첫 줄 JSON). mac.swift runDuplex 참조.
export interface LoopbackHeaderBridge {
  success: boolean;
  error?: string;
  device?: string;
  deviceUID?: string;
  channels: number;
  requested?: { sampleRate: number; bufferSize: number };
  actual: { sampleRate: number; bufferSize: number | null };
  refLen: number;
  emitFrames: number[];
  maxDelayFrames: number;
  totalFrames: number;
  analysisChannel: number;
}

interface LoopbackMeasureOpts {
  sampleRate: number;
  bufferSize: number;
  channels?: number;
  deviceUID?: string; // 생략 시 OS 기본 — 단, duplex는 입출력 겸용 단일 장치 필요
  burstCount?: number;
  refPcm: Uint8Array; // raw little-endian Float32 mono 참조 신호(--ref로 전달)
}

interface LoopbackMeasureResultBridge {
  success: boolean;
  error?: string;
  header?: LoopbackHeaderBridge;
  pcm?: Uint8Array; // Int16 인터리브 입력 캡처
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
    audioPlayCapture?: {
      // 재생할 파일 PCM 청크 핸드셰이크 — startWrite → writeChunk(반복) → finalizeWrite 순으로
      // 호출해 writeId를 얻은 뒤 start(refWriteId)로 소비한다.
      startWrite: (opts: PlayCaptureStartWriteOpts) => Promise<PlayCaptureWriteHandshakeResult>;
      writeChunk: (opts: PlayCaptureWriteChunkOpts) => Promise<PlayCaptureWriteAckResult>;
      finalizeWrite: (opts: PlayCaptureWriteIdOpts) => Promise<PlayCaptureWriteAckResult>;
      // 업로드 도중 실패/취소 시 임시 파일 정리
      cancelWrite: (opts: PlayCaptureWriteIdOpts) => Promise<PlayCaptureWriteAckResult>;
      // refWriteId(finalizeWrite로 완성해둔 ref 파일)를 출력 ch0으로 연속 재생하며 캡처를
      // onData로 스트리밍 (단일 IOProc, 단일 클록)
      start: (opts: PlayCaptureStartOpts) => Promise<PlayCaptureStartResult>;
      // 재생 위치 동결/재개 — 캡처 스트림은 계속 흐른다 (게이트는 렌더러 몫)
      control: (action: "pause" | "resume") => Promise<{ success: boolean; error?: string }>;
      stop: () => Promise<{ success: boolean }>;
      onData: (callback: (chunk: Uint8Array) => void) => () => void;
      // code 0 = 재생 완료(자기 종료), 그 외 = 비정상 종료. 사용자 stop 시에는 오지 않는다.
      onEnded: (callback: (info: { code: number | null }) => void) => () => void;
    };
    audioLoopback?: {
      // opts.refPcm(raw Float32 mono) 참조로 duplex 헬퍼가 한 번 돌아 헤더+캡처 PCM을 돌려준다.
      measure: (opts: LoopbackMeasureOpts) => Promise<LoopbackMeasureResultBridge>;
      stop: () => Promise<{ success: boolean }>;
    };
    localFolder?: {
      select: () => Promise<LocalFolderSelectResult>;
      unwatch: () => Promise<{ success: boolean }>;
      readFile: (filePath: string) => Promise<LocalFolderReadResult>;
      onChanged: (callback: (files: LocalAudioFileEntry[]) => void) => () => void;
    };
  }
}
