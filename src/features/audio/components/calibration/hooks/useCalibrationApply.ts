"use client";

// "적용" 버튼 오케스트레이션 — Context에 draft를 커밋하고, 네이티브 브리지가 있으면 capture
// probe(TN2321: 아주 잠깐 열었다 닫기)로 실제 반영된 SampleRate/BufferFrameSize를 확인한다.
// 결과(요청→실제)는 sessionStorage에 저장해 새로고침 후에도 "연결된 장치" 패널에 남는다.
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  loadDeviceActualCache, saveDeviceActualCache, type DeviceActualCache,
} from "@/features/audio/lib/cache/calibration";
import type { CalibrationValues } from "../CalibrationContext";
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
  const [deviceActual, setDeviceActual] = useState<{ sampleRate: number | null; bufferSize: number | null } | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  // "적용" 시 capture probe로 확인한 실제 런타임 값 — sessionStorage에 저장되어 새로고침(F5)
  // 후에도 "연결된 장치" 패널에 마지막 적용값이 그대로 렌더링된다.
  const [appliedRuntime, setAppliedRuntime] = useState<DeviceActualCache | null>(null);

  useEffect(() => {
    // 새로고침 후에도 마지막으로 적용된 런타임 값을 복원해 "연결된 장치" 패널에 표시
    setAppliedRuntime(loadDeviceActualCache());
  }, []);

  /** 드로어가 열릴 때마다 이전 적용 결과 표시를 지운다 (CalibrationDrawer의 [open] 오케스트레이션 effect가 호출). */
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

    // BufferFrameSize는 per-client 프로퍼티(TN2321)라 set만으로는 실제 반영 여부를 확인할
    // 수 없다 — capture(IOProc)를 아주 잠깐 열었다가 즉시 닫아 그 순간의 진짜 적용값만
    // 읽어온다(SampleRate는 capture 내부에서도 동일하게 설정됨). 결과를 보여줘야 하므로
    // 드로어는 사용자가 직접 닫는다. 이미 녹음 중이면 실패(capture-already-running)한다.
    setDeviceStatus("applying");
    setDeviceError(null);
    const requested = { sampleRate: Number(draft.sampleRate), bufferSize: Number(draft.bufferSize) };
    // 드롭다운이 이미 장치의 inputChannels 이하로 제한돼 있지만, sessionStorage 복원 등으로
    // draft가 그 제약 이전 값을 들고 있을 가능성에 대비해 여기서도 한 번 더 상한을 건다.
    const requestedChannels = Math.max(2, Number(draft.channels) || 2);
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
      setDeviceActual(result.actual ?? null);
      setDeviceStatus("applied");
      // 실제 반영된 런타임 값을 저장 → 새로고침 후에도 "연결된 장치" 패널에 유지된다.
      const runtime: DeviceActualCache = {
        requested,
        actual: result.actual ?? { sampleRate: null, bufferSize: null },
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

    // capture probe(IOProc)가 닫힌 뒤 "연결된 장치" 패널의 CoreAudio query()도 새로고침해
    // 적용 결과를 바로 확인할 수 있게 한다("새로고침" 버튼과 동일 동작).
    await refreshDeviceInfo();
  }, [draft, setValues, onApply, hasAudioDeviceBridge, deviceInfo, setOpen, refreshDeviceInfo]);

  return { deviceStatus, deviceActual, deviceError, appliedRuntime, apply, resetStatus };
}
