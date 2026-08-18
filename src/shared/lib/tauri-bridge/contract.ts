export const COMMANDS = {
  audioDeviceList: "audio_device_list",
  audioDeviceQuery: "audio_device_query",

  audioCaptureStart: "audio_capture_start",
  audioCaptureStop: "audio_capture_stop",

  audioPlayCaptureStartWrite: "audio_playcapture_start_write",
  audioPlayCaptureWriteChunk: "audio_playcapture_write_chunk",
  audioPlayCaptureFinalizeWrite: "audio_playcapture_finalize_write",
  audioPlayCaptureCancelWrite: "audio_playcapture_cancel_write",
  audioPlayCaptureStart: "audio_playcapture_start",
  audioPlayCaptureWritePcm: "audio_playcapture_write_pcm",
  audioPlayCaptureControl: "audio_playcapture_control",
  audioPlayCaptureStop: "audio_playcapture_stop",

  localFolderSelect: "local_folder_select",
  localFolderUnwatch: "local_folder_unwatch",
  localFolderReadFile: "local_folder_read_file",

  fileExportWriteTemp: "file_export_write_temp",
  fileExportSave: "file_export_save",

  wasmAssetLoad: "wasm_asset_load",
} as const;

export const ARG_KEYS = {
  opts: "opts",
  deviceUID: "deviceUID",
  sampleRate: "sampleRate",
  bufferSize: "bufferSize",
  channels: "channels",
  data: "data",
  refWriteId: "refWriteId",
  refChannels: "refChannels",
  outputChannel: "outputChannel",
  outputChannelR: "outputChannelR",
  stream: "stream",
  prefillMs: "prefillMs",
  writeId: "writeId",
  action: "action",
  path: "path",
  totalBytes: "totalBytes",
  tempPath: "tempPath",
  filename: "filename",
} as const;

export const HEADERS = {
  writeId: "x-write-id",
} as const;

export const EVENTS = {
  audioCaptureEnded: "audio-capture:ended",
  audioPlayCaptureEnded: "audio-playcapture:ended",
  localFolderChanged: "local-folder:changed",
} as const;

