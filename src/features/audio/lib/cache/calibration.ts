import type { CalibrationValues } from "@/features/audio/types";
import { readSessionJson, writeSessionJson } from "./session-json";

const KEY = "irondevice:calibration:v1";

export function saveCalibrationCache(values: CalibrationValues): void {
  writeSessionJson(KEY, values);
}

export function loadCalibrationCache(): Partial<CalibrationValues> | null {
  const parsed = readSessionJson<Partial<CalibrationValues>>(KEY);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

const DEVICE_ACTUAL_KEY = "irondevice:device-actual:v1";

export interface DeviceActualCache {
  requested: { sampleRate: number; bufferSize: number; channels?: number };
  actual: { sampleRate: number | null; bufferSize: number | null; channels?: number };
}

export function saveDeviceActualCache(v: DeviceActualCache): void {
  writeSessionJson(DEVICE_ACTUAL_KEY, v);
}

export function loadDeviceActualCache(): DeviceActualCache | null {
  const parsed = readSessionJson<DeviceActualCache>(DEVICE_ACTUAL_KEY);
  if (!parsed || typeof parsed !== "object" || !parsed.actual) return null;
  return parsed;
}
