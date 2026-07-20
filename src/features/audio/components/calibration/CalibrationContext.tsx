"use client";

// 캘리브레이션 파라미터 단일 소스 (앱 전역 Context).
// 대시보드(InputParameters 대체)와 CalibrationDrawer 가 같은 값을 공유한다 — "캘리브레이션 단일 적용".
// 엔진에 실제로 전달되는 값은 speakerModel·ampOutputPower·ambientTemp이며(EngineParams,
// buildInitMessage → parseEngineParams → ff_prot_start_exec), 나머지 프로파일 보정 필드는
// 향후 ff_prot_set_param 연동을 위한 선행 필드다(현재 모델별 SPEAKER_PROFILES 로 후처리).
import { createContext, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { loadCalibrationCache, saveCalibrationCache } from "@/features/audio/lib/cache/calibration";
import { DEFAULT_AMBIENT_TEMP, SAMPLE_RATE, SAMPLES_PER_CH } from "@/features/audio/lib/engine/core";
import { DEFAULT_TEMP_WARN, DEFAULT_TEMP_DANGER } from "@/features/audio/lib/render/detect-events";
import type { CalibrationValues } from "@/features/audio/types";

// 파일 업로드(WaveformPlayer)/마이크(MicrophonePlayer, 네이티브+getUserMedia 폴백) 두 경로 모두
// 이 값을 실제로 사용한다 — WASM 엔진(electron/native/wasm-engine/ff_prot.c)의 dt 계산과 와이어 프레임 크기에 그대로
// 반영되며, 다음 세션 시작 시점(다음 재생/다음 녹음 시작)에 적용된다(engine/core.ts EngineRuntimeConfig).
export const SAMPLE_RATE_OPTIONS = ["8000", "11025", "16000", "32000", "44100", "48000", "96000", "176400", "192000", "352800", "384000"];
export const BUFFER_SIZE_OPTIONS = ["8", "16", "32", "64", "128", "256", "480", "512", "1024", "2048"];
// 캡처 시 열 채널 수(전체 후보) — 네이티브 캡처(Electron)에서만 의미 있음. MCHStreamer 같은 다채널
// 장치의 V/I 센싱 채널을 받으려면 늘린다. 분석 파이프라인은 항상 ch0(V)/ch1(I)만 사용.
// 실제 드롭다운은 useDeviceOptionAutoCorrect가 이 목록을 선택된 장치의 inputChannels 이하로
// 필터링한 channelOptions를 쓴다 — 장치가 지원하지 않는 채널 수는 애초에 고를 수 없다.
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
