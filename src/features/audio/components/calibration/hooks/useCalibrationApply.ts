"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  loadDeviceActualCache, saveDeviceActualCache, type DeviceActualCache,
} from "@/features/audio/lib/cache/calibration";
import type { CalibrationValues } from "@/features/audio/types";
import { clampCaptureChannels } from "@/features/audio/lib/engine/core";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
import { humanizeIpcError } from "@/shared/lib/ipc-error";
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
  const { showError, showSuccess } = useErrorPopup();

  const [deviceStatus, setDeviceStatus] = useState<DeviceApplyStatus>("idle");
  // 적용된 실제 장치 값은 appliedRuntime 하나만 들고 간다 — 드로어의 "Current (Applied)"·
  // "Channels (Applied)" 행이 이 값을 읽는다. 실패 메시지도 따로 담지 않는다: deviceStatus가
  // "error"로 바뀌어 드로어에 한 줄이 뜨고, 구체적 문구는 showError 팝업이 맡는다.
  const [appliedRuntime, setAppliedRuntime] = useState<DeviceActualCache | null>(null);

  useEffect(() => {
    setAppliedRuntime(loadDeviceActualCache());
  }, []);

  const resetStatus = useCallback(() => {
    setDeviceStatus("idle");
  }, []);

  const apply = useCallback(async () => {
    setValues(draft);
    onApply?.(draft);

    if (!hasAudioDeviceBridge || !window.audioCapture) {
      setOpen(false);
      return;
    }

    setDeviceStatus("applying");
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
      setDeviceStatus("applied");
      const runtime: DeviceActualCache = {
        requested: { ...requested, channels: captureChannels },
        actual: actualWithChannels ?? { sampleRate: null, bufferSize: null },
      };
      saveDeviceActualCache(runtime);
      setAppliedRuntime(runtime);
      showSuccess(
        `Applied — requested ${draft.sampleRate}Hz/${draft.bufferSize}(${draft.channels}ch) → actual ` +
        `${actualWithChannels?.sampleRate ?? "?"}Hz/${actualWithChannels?.bufferSize ?? "?"}` +
        `${actualWithChannels?.channels ? `(${actualWithChannels.channels}ch)` : ""}`
      );
    } else {
      const message = result.error === "capture-already-running"
        ? "Microphone is already in use — stop recording and try applying again."
        : humanizeIpcError(result.error, "Failed to apply settings.");
      setDeviceStatus("error");
      showError(message);
    }

    await refreshDeviceInfo();
  }, [draft, setValues, onApply, hasAudioDeviceBridge, deviceInfo, setOpen, refreshDeviceInfo, showError, showSuccess]);

  return { deviceStatus, appliedRuntime, apply, resetStatus };
}
