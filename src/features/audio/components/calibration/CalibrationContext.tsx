"use client";

// 캘리브레이션 파라미터 단일 소스 (앱 전역 Context).
// 대시보드(InputParameters 대체)와 CalibrationDrawer 가 같은 값을 공유한다 — "캘리브레이션 단일 적용".
// 엔진에 실제로 전달되는 값은 speakerModel·ampOutputPower 이며, 나머지(주변온도/프로파일 보정)는
// 향후 ff_prot_set_param 연동을 위한 선행 필드다(현재 모델별 SPEAKER_PROFILES 로 후처리).
import { createContext, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { loadCalibrationCache, saveCalibrationCache } from "@/features/audio/lib/cache/calibration";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";

const DEFAULT_AMBIENT = 25;

// 파일 업로드(WaveformPlayer)/마이크(MicrophonePlayer, 네이티브+getUserMedia 폴백) 두 경로 모두
// 이 값을 실제로 사용한다 — WASM 엔진(native/ff_prot.c)의 dt 계산과 와이어 프레임 크기에 그대로
// 반영되며, 다음 세션 시작 시점(다음 재생/다음 녹음 시작)에 적용된다(engine/core.ts EngineRuntimeConfig).
export const SAMPLE_RATE_OPTIONS = ["8000", "11025", "16000","32000", "44100", "44100", "48000", "96000", "176400", "192000", "352800", "384000"];
export const BUFFER_SIZE_OPTIONS = ["8", "16", "32", "64", "128", "256", "480", "512", "1024", "2048"];
// 캡처 시 열 채널 수 — 네이티브 캡처(Electron)에서만 의미 있음. MCHStreamer 같은 다채널
// 장치의 V/I 센싱 채널을 받으려면 늘린다. 분석 파이프라인은 항상 ch0/ch1(L/R)만 사용.
export const CHANNEL_OPTIONS = ["2", "4", "6", "8"];

export interface CalibrationValues {
  speakerModel: string; // "" = 미선택
  ampOutputPower: string; // W
  ambientTemp: string; // °C
  sampleRate: string; // Hz (데모)
  bufferSize: string; // samples (데모)
  channels: string; // 캡처 채널 수 (네이티브 캡처 전용)
  inputDeviceId: string; // MediaDevices deviceId ("" = 시스템 기본 입력) — 마이크 캡처 대상
  inputDeviceLabel: string; // 선택 장치 이름(표시/재연결 대조용)
  captureDeviceUID: string; // CoreAudio 장치 UID ("" = OS 기본 입력) — 네이티브 캡처/조회 대상(Electron 전용)
  outputDeviceId: string; // MediaDevices deviceId ("" = 시스템 기본 출력) — 재생 라우팅 대상(WaveSurfer setSinkId). V/I 센싱 루프에서 앰프/스피커(MCHStreamer)로 음원을 보내는 출력.
  outputDeviceLabel: string; // 선택 출력 장치 이름(표시/재연결 대조용)
  tempBase: string; // °C (프로파일)
  excAmp: string; // mm (프로파일)
  tempMult: string; // 승수
  excMult: string; // 승수
  tempWarn: string; // °C — 온도 WARN 임계값(차트 markLine + detectEvents 이벤트 감지 공용)
  tempDanger: string; // °C — 온도 DANGER 임계값(차트 markLine + detectEvents 이벤트 감지 공용)
}

export const CALIBRATION_EMPTY: CalibrationValues = {
  speakerModel: "",
  ampOutputPower: "20",
  ambientTemp: String(DEFAULT_AMBIENT),
  sampleRate: "48000",
  bufferSize: "480",
  channels: "2",
  inputDeviceId: "",
  inputDeviceLabel: "",
  captureDeviceUID: "",
  outputDeviceId: "",
  outputDeviceLabel: "",
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
  // sessionStorage 복원이 끝났는지 — 끝나기 전엔 save effect가 기본값으로 캐시를 덮어쓰지 않게 막는다.
  const [hydrated, setHydrated] = useState(false);

  // 마운트 후에만 sessionStorage에서 복원 — SSR 첫 렌더와의 하이드레이션 불일치를 피한다
  // (CalibrationDrawer의 hasAudioDeviceBridge 감지와 동일한 패턴).
  useEffect(() => {
    const cached = loadCalibrationCache();
    if (cached) setValues((v) => ({ ...v, ...cached }));
    setHydrated(true);
  }, []);

  // "적용"으로 값이 바뀔 때마다(복원 완료 후부터만) sessionStorage에 저장 — 새로고침해도 유지된다.
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
