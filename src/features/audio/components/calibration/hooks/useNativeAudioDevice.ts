"use client";

import { useCallback, useEffect, useState } from "react";
import type { AudioInputDevice } from "@/shared/types/native-bridge";

export interface DeviceInfo {
  device?: string;
  current?: { sampleRate: number | null; bufferSize: number | null };
  supportedSampleRates?: number[];
  bufferRange?: { min: number; max: number };
  inputChannels?: number;
  outputChannels?: number;
}

export function useNativeAudioDevice(captureDeviceUID: string) {
  const [hasAudioDeviceBridge, setHasAudioDeviceBridge] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [deviceInfoLoading, setDeviceInfoLoading] = useState(false);
  const [nativeDevices, setNativeDevices] = useState<AudioInputDevice[]>([]);
  const [nativeDevicesLoading, setNativeDevicesLoading] = useState(false);

  useEffect(() => {
    setHasAudioDeviceBridge(typeof window !== "undefined" && !!window.audioDevice);
  }, []);

  const refreshDeviceInfo = useCallback(async (uid?: string) => {
    if (typeof window === "undefined" || !window.audioDevice) return;
    setDeviceInfoLoading(true);
    const target = uid ?? captureDeviceUID ?? "";
    const res = await window.audioDevice.query(target || undefined);
    setDeviceInfo(res.success ? res : null);
    setDeviceInfoLoading(false);
  }, [captureDeviceUID]);

  const refreshNativeDevices = useCallback(async () => {
    if (typeof window === "undefined" || !window.audioDevice?.list) return;
    setNativeDevicesLoading(true);
    const res = await window.audioDevice.list();
    setNativeDevices(res.success && res.devices ? res.devices : []);
    setNativeDevicesLoading(false);
  }, []);

  return {
    hasAudioDeviceBridge,
    deviceInfo, deviceInfoLoading, refreshDeviceInfo,
    nativeDevices, nativeDevicesLoading, refreshNativeDevices,
  };
}
