import type { CalibrationValues } from "@/features/audio/types";
import { DEFAULT_AMBIENT_TEMP, SAMPLE_RATE, SAMPLES_PER_CH } from "@/features/audio/lib/engine/core";
import { DEFAULT_TMAX, DEFAULT_XMAX } from "@/features/audio/lib/render/detect-events";

export const SAMPLE_RATE_OPTIONS = ["8000", "11025", "16000", "32000", "44100", "48000", "96000", "176400", "192000", "352800", "384000"];
export const BUFFER_SIZE_OPTIONS = ["8", "16", "32", "64", "128", "256", "480", "512", "1024", "2048"];
export const CHANNEL_OPTIONS = ["2", "4", "6", "8"];

export const CALIBRATION_EMPTY: CalibrationValues = {
  ambientTemp: String(DEFAULT_AMBIENT_TEMP),
  sampleRate: String(SAMPLE_RATE),
  bufferSize: String(SAMPLES_PER_CH),
  channels: "2",
  captureDeviceUID: "",
  outputChannel: "0",
  tmax: String(DEFAULT_TMAX),
  xmax: String(DEFAULT_XMAX),
};
