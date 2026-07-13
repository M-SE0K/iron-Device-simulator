"use client";

// navigator.mediaDevices.enumerateDevices() 기반 입출력 장치 열거 — 웹/Electron 공용.
import { useCallback, useEffect, useState } from "react";

export function useMediaDevices() {
  // OS 오디오 입력 장치 목록 — navigator.mediaDevices.enumerateDevices()로 열거(브라우저·Electron 공용). deviceId를 캘리브레이션에 저장해 웹/모바일 캡처 폴백(파일/마이크 공통)의 입력을 그 장치로 라우팅한다.
  const [hasMediaDevices, setHasMediaDevices] = useState(false);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  // 재생 출력 장치 목록(audiooutput) — WaveSurfer setSinkId 라우팅 대상. 웹·Electron 공용
  // (setSinkId는 표준 웹 API라 CoreAudio 헬퍼 없이 Chromium 렌더러에서 동작).
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  // enumerateDevices()는 마이크 권한이 없으면 label을 빈 문자열로 준다 — 이름 노출용 권한 요청 유도.
  const [labelsHidden, setLabelsHidden] = useState(false);

  useEffect(() => {
    setHasMediaDevices(typeof navigator !== "undefined" && !!navigator.mediaDevices?.enumerateDevices);
  }, []);

  // 장치 목록 새로고침 (입력 audioinput + 출력 audiooutput 한 번에 열거).
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

  // 마이크 권한을 1회 얻어 장치 이름(label)을 노출한 뒤 즉시 트랙을 닫고 재열거한다.
  const revealDeviceNames = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await refreshInputDevices();
    } catch {
      /* 권한 거부 — 이름 없이 fallback 표기 유지 */
    }
  }, [refreshInputDevices]);

  // 장치 연결/해제 시 목록 자동 갱신
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
