// Tauri shim(src/shared/lib/tauri-bridge)이 제공하며 일반 브라우저에서는 undefined다.
export {};

export interface AudioDeviceActual {
  sampleRate: number | null;
  bufferSize: number | null;
}

// audio-device:list 항목 — 연결된 입력 장치 하나 (CoreAudio/ASIO 열거). uid는 재연결에도 안정적.
export interface AudioInputDevice {
  uid: string;
  name: string;
  // Windows/ASIO 목록은 --no-probe로 호출되어 inputChannels/sampleRate가 0/null이고
  // probed=false다. macOS/CoreAudio 목록은 속성에서 실제 값을 읽지만 현재 probed 키는 보내지
  // 않는다. 확정된 장치 능력은 audioDevice.query()로 조회한다.
  inputChannels: number;
  sampleRate: number | null;
  isDefault: boolean; // OS 기본 입력 장치 여부
  probed?: boolean;
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
  outputChannels?: number; // 0이면 입력 전용 — play-capture(파일 재생) 불가
  error?: string;
}

// E2E 지연 실험(N1, src/features/audio/lib/perf-e2e/) 전용 — Tauri Rust core가 stdout 청크마다 별도
// 채널로 보내는 Date.now() 타임스탬프.
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

// audio-playcapture:start 옵션 — 파일 재생 + 캡처 (mac.swift runPlayCapture 참조)
interface PlayCaptureStartOpts {
  sampleRate: number;
  bufferSize: number;
  channels?: number;
  deviceUID?: string; // 생략 시 OS 기본 입력 — 단, play-capture는 입출력 겸용 장치 필요
  refWriteId: string; // finalizeWrite로 완성해둔 ref 파일의 writeId
  refChannels?: 1 | 2; // ref 파일의 채널 수 — 2면 인터리브 스테레오([L0,R0,L1,R1,...] Float32). 생략 시 1(모노).
  outputChannel?: number; // ref(L)를 내보낼 출력 채널 인덱스 — 생략/0이면 ch0(기본). 장치 outputChannels 범위 밖이면 헬퍼가 에러.
  outputChannelR?: number; // ref(R)를 내보낼 출력 채널 — refChannels 2와 함께 씀. 범위 밖/outputChannel과 중복이면 헬퍼가 에러 없이 모노로 폴백.
  e2e?: boolean; // true면 stdout 청크마다 onE2EMark로 타임스탬프도 보낸다 — E2E 지연 실험(N1) 전용
}

// 청크 핸드셰이크 — 재생할 파일 PCM을 한 번의 구조화 복제로 넘기지 않고 작은 조각으로
// 순차 전송한다(메인 프로세스가 동기 파일쓰기로 멎는 것을 피하려는 목적).
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

// play-capture 헤더 = capture 헤더 + 재생 메타 (mode/refLen/playbackChannel)
export interface PlayCaptureStartResult extends AudioCaptureStartResult {
  mode?: "play-capture";
  refLen?: number; // 재생 총 프레임 수 (테일 제외)
  playbackChannel?: number; // ref(L)가 실제로 나간 출력 채널 — start opts의 outputChannel 요청값을 헬퍼가 그대로 echo
  playbackChannelR?: number | null; // ref(R)가 실제로 나간 출력 채널 — 모노로 폴백됐으면 null
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
        e2e?: boolean; // true면 stdout 청크마다 onE2EMark로 타임스탬프도 보낸다 — E2E 지연 실험(N1) 전용
      }) => Promise<AudioCaptureStartResult>;
      stop: () => Promise<{ success: boolean }>;
      onData: (callback: (chunk: Uint8Array) => void) => () => void;
      onEnded: (callback: (info: { code: number | null }) => void) => () => void;
      onE2EMark: (callback: (info: AudioE2EMark) => void) => () => void;
    };
    audioPlayCapture?: {
      // 재생할 파일 PCM 청크 핸드셰이크 — startWrite → writeChunk(반복) → finalizeWrite 순으로
      // 호출해 writeId를 얻은 뒤 start(refWriteId)로 소비한다.
      startWrite: (opts: PlayCaptureStartWriteOpts) => Promise<PlayCaptureWriteHandshakeResult>;
      writeChunk: (opts: PlayCaptureWriteChunkOpts) => Promise<PlayCaptureWriteAckResult>;
      finalizeWrite: (opts: PlayCaptureWriteIdOpts) => Promise<PlayCaptureWriteAckResult>;
      // 업로드 도중 실패/취소 시 임시 파일 정리
      cancelWrite: (opts: PlayCaptureWriteIdOpts) => Promise<PlayCaptureWriteAckResult>;
      // refWriteId(finalizeWrite로 완성해둔 ref 파일)를 출력 채널(기본 ch0, opts.outputChannel로
      // 지정 가능)로 연속 재생하며 캡처를 onData로 스트리밍 (단일 IOProc, 단일 클록).
      // refChannels:2 + outputChannelR을 같이 주면 스테레오 재생을 시도한다(장치가 안 되면 모노 폴백).
      start: (opts: PlayCaptureStartOpts) => Promise<PlayCaptureStartResult>;
      // 재생 위치 동결/재개 — 캡처 스트림은 계속 흐른다 (게이트는 렌더러 몫)
      control: (action: "pause" | "resume") => Promise<{ success: boolean; error?: string }>;
      stop: () => Promise<{ success: boolean }>;
      onData: (callback: (chunk: Uint8Array) => void) => () => void;
      // code 0 = 재생 완료(자기 종료), 그 외 = 비정상 종료. 사용자 stop 시에는 오지 않는다.
      onEnded: (callback: (info: { code: number | null }) => void) => () => void;
      onE2EMark: (callback: (info: AudioE2EMark) => void) => () => void;
    };
    localFolder?: {
      select: () => Promise<LocalFolderSelectResult>;
      unwatch: () => Promise<{ success: boolean }>;
      readFile: (filePath: string) => Promise<LocalFolderReadResult>;
      onChanged: (callback: (files: LocalAudioFileEntry[]) => void) => () => void;
    };
    // WASM 알고리즘 암호화 배포(방법 5) — src-tauri/src/wasm_asset.rs가 암호화된
    // ff_prot.wasm.enc를 복호화해 돌려준다. wasm-client.ts가 Module.instantiateWasm 훅으로
    // 바로 인스턴스화한다(Module.wasmBinary는 emcc 6.x 글루가 읽지 않는다).
    // ArrayBuffer로 좁혀둔다 — 출처가 항상 tauri invoke 응답(ArrayBuffer) 위의 뷰라
    // SharedArrayBuffer가 될 수 없고, WebAssembly.compile(BufferSource)에 그대로 넘겨야 한다.
    wasmAsset?: {
      loadEngineBinary: () => Promise<Uint8Array<ArrayBuffer>>;
    };
  }
}
