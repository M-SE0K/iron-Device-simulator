"use client";

// 우측 슬라이딩 드로어 — 캘리브레이션 파라미터 편집(앱 전역 단일 소스).
// 값은 CalibrationProvider(Context)에 보관되어 대시보드 분석에 그대로 쓰인다("캘리브레이션 단일 적용").
// 편집은 로컬 draft 에서 하고 "적용" 시 Context 에 커밋한다.
//   · 스피커 모델 / AMP 출력 전력(W) / 주변 온도(°C)
//   · 선택 모델의 물리 프로파일(SPEAKER_PROFILES): 온도 베이스·익스커션 진폭·승수
// 좌측 WorkspaceDrawer와 동일하게 항상 마운트된 순수 DOM(비Radix)로 구현 — open 불리언으로
// 클래스만 토글해 열기/닫기 양방향 슬라이드·페이드 애니메이션을 대칭적으로 재생한다.
import { useEffect, useState } from "react";
import { RotateCcw, SlidersHorizontal, X } from "lucide-react";
import {
  BUFFER_SIZE_OPTIONS,
  CALIBRATION_EMPTY,
  SAMPLE_RATE_OPTIONS,
  SPEAKER_MODELS,
  useCalibration,
  withProfile,
  type CalibrationValues,
} from "./Calibration-context";

/** 드롭다운 선택 필드 */
function SelectField({
  label,
  unit,
  value,
  options,
  onChange,
}: {
  label: string;
  unit?: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-iron-200 bg-white font-mono text-sm text-iron-800 focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue cursor-pointer"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
            {unit ? ` ${unit}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 숫자 입력 필드 (소수 허용) */
function NumberField({
  label,
  unit,
  value,
  onChange,
  disabled,
}: {
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">{label}</label>
      <div className="relative flex items-center">
        <input
          type="text"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder={disabled ? "모델 선택 필요" : "0"}
          className="w-full pr-9 pl-3 py-2 rounded-lg border border-iron-200 bg-white font-mono text-sm text-iron-800 focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue placeholder:text-iron-300 disabled:bg-iron-50 disabled:text-iron-300"
        />
        {unit && (
          <span className="absolute right-3 text-xs font-mono font-semibold text-iron-400 pointer-events-none select-none">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

interface Props {
  /** 선택된 프로젝트명(컨텍스트 표시용, 선택) */
  projectName?: string | null;
  /** 적용 콜백(선택) — 커밋 후 추가 동작 */
  onApply?: (values: CalibrationValues) => void;
}

type DeviceApplyStatus = "idle" | "applying" | "applied" | "error";

export default function CalibrationDrawer({ projectName, onApply }: Props) {
  const { values, setValues } = useCalibration();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CalibrationValues>(values);

  // window.audioDevice는 Electron 데스크톱 빌드에서만 존재(preload.js) — 브라우저/개발서버에서는
  // 항상 undefined. 하이드레이션 불일치를 피하려 마운트 후에만 감지한다.
  const [hasAudioDeviceBridge, setHasAudioDeviceBridge] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState<DeviceApplyStatus>("idle");
  const [deviceActual, setDeviceActual] = useState<{ sampleRate: number | null; bufferSize: number | null } | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  useEffect(() => {
    setHasAudioDeviceBridge(typeof window !== "undefined" && !!window.audioDevice);
  }, []);

  // 열 때마다 현재 적용값으로 draft 동기화
  useEffect(() => {
    if (!open) return;
    setDraft(values);
    setDeviceStatus("idle");
    setDeviceActual(null);
    setDeviceError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const set = (patch: Partial<CalibrationValues>) => setDraft((v) => ({ ...v, ...patch }));
  const profileLoaded = SPEAKER_MODELS.includes(draft.speakerModel);

  const apply = async () => {
    setValues(draft);
    onApply?.(draft);

    if (!hasAudioDeviceBridge || !window.audioDevice) {
      setOpen(false);
      return;
    }

    // 실제 하드웨어(예: MCHStreamer)에 반영 — 결과를 보여줘야 하므로 드로어는 사용자가 직접 닫는다.
    setDeviceStatus("applying");
    setDeviceError(null);
    const result = await window.audioDevice.setConfig(Number(draft.sampleRate), Number(draft.bufferSize));
    if (result.success) {
      setDeviceActual(result.actual ?? null);
      setDeviceStatus("applied");
    } else {
      setDeviceStatus("error");
      setDeviceError(result.error ?? "설정 적용 실패");
    }
  };

  return (
    <>
      {/* 트리거 (우측) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="캘리브레이션 열기"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm text-iron-600 hover:bg-iron-100 hover:text-iron-900 transition"
      >
        <SlidersHorizontal className="w-4 h-4" />
      </button>

      {/* 배경 오버레이 */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`fixed inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 우측 슬라이딩 패널 */}
      <aside
        className={`fixed top-0 right-0 z-50 h-full w-96 max-w-[92vw] bg-white border-l border-iron-100 shadow-xl flex flex-col transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-label="Calibration Parameter"
        aria-hidden={!open}
      >
        <div className="h-14 px-4 shrink-0 flex items-center justify-between border-b border-iron-100">
          <div className="flex items-center gap-2 min-w-0">
            <SlidersHorizontal className="w-4 h-4 text-brand-blue shrink-0" />
            <span className="text-sm font-semibold text-iron-900">Calibration Parameter</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="닫기"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-5">
          {projectName && (
            <div className="px-3 py-2 rounded-lg bg-brand-blue/5 text-xs text-brand-blue">
              대상: <span className="font-medium">{projectName}</span>
            </div>
          )}

          {/* 기본 입력 */}
          <section className="space-y-3">
            <h4 className="text-xs font-semibold text-iron-500">기본</h4>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">Speaker Model</label>
              <select
                value={draft.speakerModel}
                onChange={(e) => setDraft((v) => withProfile(v, e.target.value))}
                className="w-full px-3 py-2 rounded-lg border border-iron-200 bg-white font-mono text-sm text-iron-800 focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue cursor-pointer"
              >
                <option value="">Select model…</option>
                {SPEAKER_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="AMP Output Power" unit="W" value={draft.ampOutputPower} onChange={(v) => set({ ampOutputPower: v })} />
              <NumberField label="Ambient Temp" unit="°C" value={draft.ambientTemp} onChange={(v) => set({ ambientTemp: v })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="Sample Rate"
                unit="Hz"
                value={draft.sampleRate}
                options={SAMPLE_RATE_OPTIONS}
                onChange={(v) => set({ sampleRate: v })}
              />
              <SelectField
                label="Buffer Size"
                value={draft.bufferSize}
                options={BUFFER_SIZE_OPTIONS}
                onChange={(v) => set({ bufferSize: v })}
              />
            </div>
            {hasAudioDeviceBridge && (
              <div className="text-xs">
                {deviceStatus === "applying" && <p className="text-iron-400">디바이스에 적용 중…</p>}
                {deviceStatus === "applied" && (
                  <p className="text-emerald-600">
                    적용됨 — 요청 {draft.sampleRate}Hz/{draft.bufferSize} → 실제{" "}
                    {deviceActual?.sampleRate ?? "?"}Hz/{deviceActual?.bufferSize ?? "?"}
                  </p>
                )}
                {deviceStatus === "error" && <p className="text-red-500">디바이스 적용 실패: {deviceError}</p>}
              </div>
            )}
          </section>

          {/* 프로파일 보정 */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-iron-500">물리 프로파일 보정</h4>
              {profileLoaded && (
                <button
                  type="button"
                  onClick={() => setDraft((v) => withProfile(v, v.speakerModel))}
                  className="flex items-center gap-1 text-[11px] text-iron-400 hover:text-iron-700"
                >
                  <RotateCcw className="w-3 h-3" /> 프로파일 기본값
                </button>
              )}
            </div>
            {!profileLoaded && (
              <p className="text-xs text-iron-300">모델을 선택하면 기본 보정값이 채워집니다.</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Temp Base" unit="°C" value={draft.tempBase} onChange={(v) => set({ tempBase: v })} disabled={!profileLoaded} />
              <NumberField label="Excursion Amp" unit="mm" value={draft.excAmp} onChange={(v) => set({ excAmp: v })} disabled={!profileLoaded} />
              <NumberField label="Temp Multiplier" value={draft.tempMult} onChange={(v) => set({ tempMult: v })} disabled={!profileLoaded} />
              <NumberField label="Exc Multiplier" value={draft.excMult} onChange={(v) => set({ excMult: v })} disabled={!profileLoaded} />
            </div>
          </section>
        </div>

        <div className="p-3 border-t border-iron-100 shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDraft(CALIBRATION_EMPTY)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-iron-500 border border-iron-200 hover:bg-iron-100"
          >
            <RotateCcw className="w-4 h-4" /> 초기화
          </button>
          <button
            type="button"
            onClick={apply}
            className="flex-1 px-3 py-2 rounded-lg text-sm text-white bg-brand-blue hover:bg-brand-blue/90"
          >
            적용
          </button>
        </div>
      </aside>
    </>
  );
}
