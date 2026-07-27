"use client";

import { useEffect, useState } from "react";
import { SAMPLE_RATE_OPTIONS, BUFFER_SIZE_OPTIONS, CHANNEL_OPTIONS } from "../CalibrationContext";
import type { CalibrationValues } from "@/features/audio/types";
import type { DeviceInfo } from "./useNativeAudioDevice";

function nearestOption(options: string[], value: string): string | null {
  if (!options.length) return null;
  const target = Number(value);
  if (!Number.isFinite(target)) return options[0];
  return options.reduce((best, o) =>
    Math.abs(Number(o) - target) < Math.abs(Number(best) - target) ? o : best,
  );
}

export interface DeviceOptionAutoCorrectDeps {
  deviceInfo: DeviceInfo | null;
  deviceInfoLoading: boolean;
  hasAudioDeviceBridge: boolean;
  draft: CalibrationValues;
  set: (patch: Partial<CalibrationValues>) => void;
}

export function useDeviceOptionAutoCorrect(deps: DeviceOptionAutoCorrectDeps) {
  const { deviceInfo, deviceInfoLoading, hasAudioDeviceBridge, draft, set } = deps;

  const [adjustedNote, setAdjustedNote] = useState<string | null>(null);

  const sampleRateOptions = deviceInfo?.supportedSampleRates?.length
    ? deviceInfo.supportedSampleRates.map(String)
    : SAMPLE_RATE_OPTIONS;
  const bufferSizeOptions = (() => {
    const r = deviceInfo?.bufferRange;
    if (!r) return BUFFER_SIZE_OPTIONS;
    const inRange = BUFFER_SIZE_OPTIONS.filter((b) => Number(b) >= r.min && Number(b) <= r.max);
    return inRange.length ? inRange : BUFFER_SIZE_OPTIONS;
  })();
  const channelOptions = (() => {
    const max = deviceInfo?.inputChannels;
    if (!max) return CHANNEL_OPTIONS;
    const inRange = CHANNEL_OPTIONS.filter((c) => Number(c) <= max);
    return inRange.length ? inRange : CHANNEL_OPTIONS;
  })();
  const deviceOptionsLoading = hasAudioDeviceBridge && deviceInfoLoading;

  useEffect(() => {
    if (!deviceInfo || deviceInfoLoading) return;
    const patch: Partial<CalibrationValues> = {};
    const notes: string[] = [];
    if (!sampleRateOptions.includes(draft.sampleRate)) {
      const nearest = nearestOption(sampleRateOptions, draft.sampleRate);
      if (nearest && nearest !== draft.sampleRate) {
        patch.sampleRate = nearest;
        notes.push(`Sample Rate ${draft.sampleRate}→${nearest}Hz`);
      }
    }
    if (!bufferSizeOptions.includes(draft.bufferSize)) {
      const nearest = nearestOption(bufferSizeOptions, draft.bufferSize);
      if (nearest && nearest !== draft.bufferSize) {
        patch.bufferSize = nearest;
        notes.push(`Buffer ${draft.bufferSize}→${nearest}`);
      }
    }
    if (!channelOptions.includes(draft.channels)) {
      const nearest = nearestOption(channelOptions, draft.channels);
      if (nearest && nearest !== draft.channels) {
        patch.channels = nearest;
        notes.push(`Channels ${draft.channels}→${nearest}`);
      }
    }
    if (notes.length) {
      set(patch);
      setAdjustedNote(`Auto-adjusted — not supported by this device: ${notes.join(", ")}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceInfo, deviceInfoLoading]);

  return {
    sampleRateOptions, bufferSizeOptions, channelOptions, deviceOptionsLoading,
    adjustedNote, clearAdjustedNote: () => setAdjustedNote(null),
  };
}
