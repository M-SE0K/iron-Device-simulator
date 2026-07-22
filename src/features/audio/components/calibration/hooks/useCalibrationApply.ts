"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  loadDeviceActualCache, saveDeviceActualCache, type DeviceActualCache,
} from "@/features/audio/lib/cache/calibration";
import type { CalibrationValues } from "@/features/audio/types";
import { clampCaptureChannels } from "@/features/audio/lib/engine/core";
import type { DeviceInfo } from "./useNativeAudioDevice";

export type DeviceApplyStatus = "idle" | "applying" | "applied" | "error";

export interface UseCalibrationApplyDeps {
  draft: CalibrationValues;
  setValues: Dispatch<SetStateAction<CalibrationValues>>;
  setOpen: (v: boolean) => void;
  hasAudioDeviceBridge: boolean;
  deviceInfo: DeviceInfo | null;
  refreshDeviceInfo: (uid?: string) => Promise<void>;
  onApply?: (values: CalibrationValues) => void;
}

export function useCalibrationApply(deps: UseCalibrationApplyDeps) {
  const { draft, setValues, setOpen, hasAudioDeviceBridge, deviceInfo, refreshDeviceInfo, onApply } = deps;

  const [deviceStatus, setDeviceStatus] = useState<DeviceApplyStatus>("idle");
  const [deviceActual, setDeviceActual] = useState<{ sampleRate: number | null; bufferSize: number | null; channels?: number } | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [appliedRuntime, setAppliedRuntime] = useState<DeviceActualCache | null>(null);

  useEffect(() => {
    setAppliedRuntime(loadDeviceActualCache());
  }, []);

  const resetStatus = useCallback(() => {
    setDeviceStatus("idle");
    setDeviceActual(null);
    setDeviceError(null);
  }, []);

  const apply = useCallback(async () => {
    setValues(draft);
    onApply?.(draft);

    if (!hasAudioDeviceBridge || !window.audioCapture) {
      setOpen(false);
      return;
    }

    setDeviceStatus("applying");
    setDeviceError(null);
    const requested = { sampleRate: Number(draft.sampleRate), bufferSize: Number(draft.bufferSize) };
    const requestedChannels = clampCaptureChannels(draft.channels);
    const captureChannels = deviceInfo?.inputChannels
      ? Math.min(requestedChannels, deviceInfo.inputChannels)
      : requestedChannels;
    const result = await window.audioCapture.start({
      sampleRate: requested.sampleRate,
      bufferSize: requested.bufferSize,
      channels:   captureChannels,
      deviceUID:  draft.captureDeviceUID || undefined,
    });

    if (result.success) {
      await window.audioCapture.stop();
      const actualWithChannels = result.actual
        ? { ...result.actual, channels: result.channels }
        : null;
      setDeviceActual(actualWithChannels);
      setDeviceStatus("applied");
      const runtime: DeviceActualCache = {
        requested: { ...requested, channels: captureChannels },
        actual: actualWithChannels ?? { sampleRate: null, bufferSize: null },
      };
      saveDeviceActualCache(runtime);
      setAppliedRuntime(runtime);
    } else {
      setDeviceStatus("error");
      setDeviceError(
        result.error === "capture-already-running"
          ? "마이크가 이미 사용 중입니다 — 녹음을 멈춘 뒤 다시 적용해주세요."
          : result.error ?? "설정 적용 실패"
      );
    }

    await refreshDeviceInfo();
  }, [draft, setValues, onApply, hasAudioDeviceBridge, deviceInfo, setOpen, refreshDeviceInfo]);

  return { deviceStatus, deviceActual, deviceError, appliedRuntime, apply, resetStatus };
}
