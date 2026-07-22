"use client";

import { useCallback, useEffect, useState } from "react";

export function useMediaDevices() {
  const [hasMediaDevices, setHasMediaDevices] = useState(false);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [labelsHidden, setLabelsHidden] = useState(false);

  useEffect(() => {
    setHasMediaDevices(typeof navigator !== "undefined" && !!navigator.mediaDevices?.enumerateDevices);
  }, []);

  const refreshInputDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    setDevicesLoading(true);
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === "audioinput");
      setInputDevices(inputs);
      setOutputDevices(all.filter((d) => d.kind === "audiooutput"));
      setLabelsHidden(inputs.length > 0 && inputs.every((d) => !d.label));
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  const revealDeviceNames = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await refreshInputDevices();
    } catch {
    }
  }, [refreshInputDevices]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return;
    const handler = () => refreshInputDevices();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [refreshInputDevices]);

  return {
    hasMediaDevices, inputDevices, outputDevices, devicesLoading, labelsHidden,
    refreshInputDevices, revealDeviceNames,
  };
}
