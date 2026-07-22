"use client";

import { createContext, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { loadCalibrationCache, saveCalibrationCache } from "@/features/audio/lib/cache/calibration";
import { DEFAULT_AMBIENT_TEMP, SAMPLE_RATE, SAMPLES_PER_CH } from "@/features/audio/lib/engine/core";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import type { CalibrationValues } from "@/features/audio/types";

export const SAMPLE_RATE_OPTIONS = ["8000", "11025", "16000", "32000", "44100", "48000", "96000", "176400", "192000", "352800", "384000"];
export const BUFFER_SIZE_OPTIONS = ["8", "16", "32", "64", "128", "256", "480", "512", "1024", "2048"];
export const CHANNEL_OPTIONS = ["2", "4", "6", "8"];

export const CALIBRATION_EMPTY: CalibrationValues = {
  speakerModel: "",
  ampOutputPower: "20",
  ambientTemp: String(DEFAULT_AMBIENT_TEMP),
  sampleRate: String(SAMPLE_RATE),
  bufferSize: String(SAMPLES_PER_CH),
  channels: "2",
  inputDeviceId: "",
  inputDeviceLabel: "",
  captureDeviceUID: "",
  outputDeviceId: "",
  outputDeviceLabel: "",
  outputChannel: "0",
  tempBase: "",
  excAmp: "",
  tempMult: "",
  excMult: "",
  tempWarn: String(DEFAULT_TEMP_WARN),
  tempDanger: String(DEFAULT_TEMP_DANGER),
};

interface CalibrationCtx {
  values: CalibrationValues;
  setValues: Dispatch<SetStateAction<CalibrationValues>>;
}

const Ctx = createContext<CalibrationCtx | null>(null);

export function CalibrationProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<CalibrationValues>(CALIBRATION_EMPTY);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const cached = loadCalibrationCache();
    if (cached) setValues((v) => ({ ...v, ...cached }));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveCalibrationCache(values);
  }, [hydrated, values]);

  const ctx = useMemo(() => ({ values, setValues }), [values]);
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function useCalibration(): CalibrationCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCalibration must be used within CalibrationProvider");
  return ctx;
}
