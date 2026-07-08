"use client";

// window.audioDevice(Electron CoreAudio 헬퍼) 조회/열거 — 읽기 전용 데이터 페칭이라
// 실패해도 "연결된 장치" 정보 패널만 비어 보일 뿐, 실시간 온도/익스커션 표시나 캡처
// 자체에는 영향이 없다.
import { useCallback, useEffect, useState } from "react";
import type { AudioInputDevice } from "@/shared/types/electron-bridge";

// window.audioDevice.query()가 돌려주는 장치 능력 정보 (electron-bridge.d.ts의 AudioDeviceQueryResult)
export interface DeviceInfo {
  device?: string;
  current?: { sampleRate: number | null; bufferSize: number | null };
  supportedSampleRates?: number[];
  bufferRange?: { min: number; max: number };
  inputChannels?: number;
}

/**
 * captureDeviceUID: refreshDeviceInfo(uid 생략 시) 대상 장치 — CalibrationDrawer의
 * draft.captureDeviceUID를 매 렌더 최신값으로 전달받는다.
 */
export function useNativeAudioDevice(captureDeviceUID: string) {
  // window.audioDevice는 Electron 데스크톱 빌드에서만 존재(preload.js) — 브라우저/개발서버에서는
  // 항상 undefined. 하이드레이션 불일치를 피하려 마운트 후에만 감지한다.
  const [hasAudioDeviceBridge, setHasAudioDeviceBridge] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [deviceInfoLoading, setDeviceInfoLoading] = useState(false);
  // CoreAudio 네이티브 장치 목록(window.audioDevice.list) — Electron 전용. UID로 캡처/조회 대상을 고른다.
  const [nativeDevices, setNativeDevices] = useState<AudioInputDevice[]>([]);
  const [nativeDevicesLoading, setNativeDevicesLoading] = useState(false);

  useEffect(() => {
    setHasAudioDeviceBridge(typeof window !== "undefined" && !!window.audioDevice);
  }, []);

  // 연결된 장치 능력(현재값·지원 SampleRate·Buffer 범위·입력 채널 수) 조회 — Electron 전용.
  // uid를 넘기면 그 장치를, 생략하면 현재 선택된 captureDeviceUID(없으면 OS 기본 입력)를 대상으로 한다.
  const refreshDeviceInfo = useCallback(async (uid?: string) => {
    if (typeof window === "undefined" || !window.audioDevice) return;
    setDeviceInfoLoading(true);
    const target = uid ?? captureDeviceUID ?? "";
    const res = await window.audioDevice.query(target || undefined);
    setDeviceInfo(res.success ? res : null);
    setDeviceInfoLoading(false);
  }, [captureDeviceUID]);

  // CoreAudio 장치 목록 새로고침 — 연결된 입력 장치 전체(uid/name/inputChannels). Electron 전용.
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
