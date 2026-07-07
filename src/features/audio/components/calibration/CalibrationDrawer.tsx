"use client";

// 우측 슬라이딩 드로어 — 캘리브레이션 파라미터 편집(앱 전역 단일 소스).
// 값은 CalibrationProvider(Context)에 보관되어 대시보드 분석에 그대로 쓰인다("캘리브레이션 단일 적용").
// 편집은 로컬 draft 에서 하고 "적용" 시 Context 에 커밋한다.
//   · 스피커 모델 / AMP 출력 전력(W) / 주변 온도(°C)
//   · 선택 모델의 물리 프로파일(SPEAKER_PROFILES): 온도 베이스·익스커션 진폭·승수
// 좌측 WorkspaceDrawer와 동일하게 항상 마운트된 순수 DOM(비Radix)로 구현 — open 불리언으로
// 클래스만 토글해 열기/닫기 양방향 슬라이드·페이드 애니메이션을 대칭적으로 재생한다.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import AnimatedSelect from "@/shared/components/AnimatedSelect";
import { useAnalysisMode } from "@/features/audio/components/AnalysisModeContext";
import {
  BUFFER_SIZE_OPTIONS,
  CALIBRATION_EMPTY,
  CHANNEL_OPTIONS,
  SAMPLE_RATE_OPTIONS,
  useCalibration,
  type CalibrationValues,
} from "./Calibration-context";
import {
  loadDeviceActualCache,
  saveDeviceActualCache,
  type DeviceActualCache,
} from "@/features/audio/lib/cache/calibration";

// window.audioDevice.query()가 돌려주는 장치 능력 정보 (electron-bridge.d.ts의 AudioDeviceQueryResult)
interface DeviceInfo {
  device?: string;
  current?: { sampleRate: number | null; bufferSize: number | null };
  supportedSampleRates?: number[];
  bufferRange?: { min: number; max: number };
  inputChannels?: number;
}

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
      <AnimatedSelect
        value={value}
        unit={unit}
        options={options.map((o) => ({ value: o }))}
        onChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

/** 세그먼트 토글 — 활성 항목 아래로 흰색 하이라이트가 미끄러지는 애니메이션 컨트롤 */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">{label}</label>
      <div
        className={`relative grid p-1 rounded-lg bg-iron-100 ${disabled ? "opacity-50" : ""}`}
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {/* 미끄러지는 활성 하이라이트 */}
        <span
          aria-hidden
          className="absolute top-1 bottom-1 rounded-md bg-white shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          style={{
            left: "0.25rem",
            width: `calc((100% - 0.5rem) / ${options.length})`,
            transform: `translateX(${idx * 100}%)`,
          }}
        />
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={`relative z-10 py-1.5 text-xs font-medium rounded-md transition-colors duration-200 disabled:cursor-not-allowed ${
                active ? "text-iron-900" : "text-iron-400 hover:text-iron-600"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
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

/** 장치 정보 한 줄 (label · value) */
function DeviceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <dt className="text-iron-400 shrink-0">{label}</dt>
      <dd className="text-iron-700 text-right break-all">{value}</dd>
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
  // 입력 소스(파일/마이크) · 분석 모드(실시간 추적/분석) — 대시보드가 제공하는 컨텍스트.
  // 대시보드 밖(Provider 부재)에서는 null 이므로 해당 섹션을 숨긴다.
  const mode = useAnalysisMode();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CalibrationValues>(values);

  // window.audioDevice는 Electron 데스크톱 빌드에서만 존재(preload.js) — 브라우저/개발서버에서는
  // 항상 undefined. 하이드레이션 불일치를 피하려 마운트 후에만 감지한다.
  const [hasAudioDeviceBridge, setHasAudioDeviceBridge] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState<DeviceApplyStatus>("idle");
  const [deviceActual, setDeviceActual] = useState<{ sampleRate: number | null; bufferSize: number | null } | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [deviceInfoLoading, setDeviceInfoLoading] = useState(false);
  // "적용" 시 capture probe로 확인한 실제 런타임 값 — sessionStorage에 저장되어 새로고침(F5)
  // 후에도 "연결된 장치" 패널에 마지막 적용값이 그대로 렌더링된다.
  const [appliedRuntime, setAppliedRuntime] = useState<DeviceActualCache | null>(null);

  // OS 오디오 입력 장치 목록 — navigator.mediaDevices.enumerateDevices()로 열거(브라우저·Electron 공용).
  // deviceId를 캘리브레이션에 저장해 마이크 캡처 대상(MicrophonePlayer)을 그 장치로 라우팅한다.
  const [hasMediaDevices, setHasMediaDevices] = useState(false);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  // enumerateDevices()는 마이크 권한이 없으면 label을 빈 문자열로 준다 — 이름 노출용 권한 요청 유도.
  const [labelsHidden, setLabelsHidden] = useState(false);

  useEffect(() => {
    setHasAudioDeviceBridge(typeof window !== "undefined" && !!window.audioDevice);
    setHasMediaDevices(typeof navigator !== "undefined" && !!navigator.mediaDevices?.enumerateDevices);
    // 새로고침 후에도 마지막으로 적용된 런타임 값을 복원해 "연결된 장치" 패널에 표시
    setAppliedRuntime(loadDeviceActualCache());
  }, []);

  // 입력 장치 목록 새로고침 (audioinput만).
  const refreshInputDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    setDevicesLoading(true);
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === "audioinput");
      setInputDevices(inputs);
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

  // 연결된 장치 능력(현재값·지원 SampleRate·Buffer 범위·입력 채널 수) 조회 — Electron 전용.
  const refreshDeviceInfo = async () => {
    if (typeof window === "undefined" || !window.audioDevice) return;
    setDeviceInfoLoading(true);
    const res = await window.audioDevice.query();
    setDeviceInfo(res.success ? res : null);
    setDeviceInfoLoading(false);
  };

  // 열 때마다 현재 적용값으로 draft 동기화 + 장치 정보 새로고침
  useEffect(() => {
    if (!open) return;
    setDraft(values);
    setDeviceStatus("idle");
    setDeviceActual(null);
    setDeviceError(null);
    refreshDeviceInfo();
    refreshInputDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const set = (patch: Partial<CalibrationValues>) => setDraft((v) => ({ ...v, ...patch }));

  // DEVICE 섹션 선택지 — Electron(Swift/CoreAudio) query()로 받은 장치 능력이 있으면 그 값으로,
  // 없으면(브라우저) 데모 목록으로 SampleRate/Buffer 옵션을 구성한다.
  const sampleRateOptions = deviceInfo?.supportedSampleRates?.length
    ? deviceInfo.supportedSampleRates.map(String)
    : SAMPLE_RATE_OPTIONS;
  const bufferSizeOptions = (() => {
    const r = deviceInfo?.bufferRange;
    if (!r) return BUFFER_SIZE_OPTIONS;
    const inRange = BUFFER_SIZE_OPTIONS.filter((b) => Number(b) >= r.min && Number(b) <= r.max);
    return inRange.length ? inRange : BUFFER_SIZE_OPTIONS;
  })();

  const apply = async () => {
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
    const captureChannels = Math.max(2, Number(draft.channels) || 2);
    const result = await window.audioCapture.start({
      sampleRate: requested.sampleRate,
      bufferSize: requested.bufferSize,
      channels:   captureChannels,
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

          {/* 입력 소스 / 분석 모드 — 대시보드에서 이동한 토글 (컨텍스트 부재 시 숨김) */}
          {mode && (
            <section className="space-y-3">
              <Segmented
                label="Input Source"
                value={mode.inputMode}
                onChange={mode.setInputMode}
                options={[
                  { value: "file", label: "파일" },
                  { value: "mic", label: "마이크" },
                ]}
              />
              {/* 분석 모드는 파일 입력에서만 의미가 있다(마이크는 항상 실시간) */}
              {mode.inputMode === "file" && (
                <Segmented
                  label="Analysis Mode"
                  value={mode.analysisMode}
                  onChange={mode.setAnalysisMode}
                  disabled={mode.isAnalyzing}
                  options={[
                    { value: "realtime", label: "실시간 추적" },
                    { value: "batch", label: "분석" },
                  ]}
                />
              )}
            </section>
          )}

          {/* 기본 입력 */}
          <section className="space-y-3">
            {/* 입력 장치 — OS(navigator.mediaDevices)로 열거, 선택 시 마이크 캡처 대상이 된다 */}
            {hasMediaDevices && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">
                    Input Device
                  </label>
                  <button
                    type="button"
                    onClick={labelsHidden ? revealDeviceNames : refreshInputDevices}
                    disabled={devicesLoading}
                    className="flex items-center gap-1 text-[11px] text-iron-400 hover:text-iron-700 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${devicesLoading ? "animate-spin" : ""}`} />
                    {labelsHidden ? "이름 표시" : "새로고침"}
                  </button>
                </div>
                <AnimatedSelect
                  value={draft.inputDeviceId}
                  aria-label="Input Device"
                  onChange={(id) => {
                    const dev = inputDevices.find((d) => d.deviceId === id);
                    set({ inputDeviceId: id, inputDeviceLabel: dev?.label ?? "" });
                  }}
                  options={[
                    { value: "", label: "시스템 기본 입력" },
                    ...inputDevices.map((d, i) => ({
                      value: d.deviceId,
                      label: d.label || `마이크 ${i + 1}`,
                    })),
                    // 저장된 장치가 현재 목록에 없으면(연결 해제) 값이 사라지지 않게 보존 표시
                    ...(draft.inputDeviceId && !inputDevices.some((d) => d.deviceId === draft.inputDeviceId)
                      ? [
                          {
                            value: draft.inputDeviceId,
                            label: draft.inputDeviceLabel || "저장된 장치",
                            hint: "연결 안 됨",
                          },
                        ]
                      : []),
                  ]}
                />
                {labelsHidden && (
                  <p className="text-[10px] text-iron-300 leading-relaxed">
                    마이크 권한을 허용하면 장치 이름이 표시됩니다.
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <NumberField label="AMP Output Power" unit="W" value={draft.ampOutputPower} onChange={(v) => set({ ampOutputPower: v })} />
              <NumberField label="Ambient Temp" unit="°C" value={draft.ambientTemp} onChange={(v) => set({ ambientTemp: v })} />
            </div>
          </section>

          {/* 연결된 장치 정보 (Electron 전용) */}
          {hasAudioDeviceBridge && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-iron-500">연결된 장치</h4>
                <button
                  type="button"
                  onClick={refreshDeviceInfo}
                  disabled={deviceInfoLoading}
                  className="flex items-center gap-1 text-[11px] text-iron-400 hover:text-iron-700 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${deviceInfoLoading ? "animate-spin" : ""}`} /> 새로고침
                </button>
              </div>
              {!deviceInfo && !deviceInfoLoading && (
                <p className="text-xs text-iron-300">장치 정보를 불러오지 못했습니다.</p>
              )}
              {deviceInfo && (
                <dl className="rounded-lg border border-iron-200 bg-iron-50/60 divide-y divide-iron-100 text-xs font-mono">
                  <DeviceRow label="Device" value={deviceInfo.device || "—"} />
                  {/* "적용"으로 확인한 실제 런타임 값이 있으면 그 값을(새로고침 후에도 유지),
                      없으면 query()의 장치 기본값을 보여준다. Buffer는 per-client(TN2321)라
                      적용 후에는 런타임 값이 실제 반영값이다. */}
                  <DeviceRow
                    label={appliedRuntime ? "현재(적용값)" : "현재(기본값)"}
                    value={
                      appliedRuntime
                        ? `${appliedRuntime.actual.sampleRate ?? "?"}Hz / ${appliedRuntime.actual.bufferSize ?? "?"} frames`
                        : `${deviceInfo.current?.sampleRate ?? "?"}Hz / ${deviceInfo.current?.bufferSize ?? "?"} frames`
                    }
                  />
                  <DeviceRow label="입력 채널" value={`${deviceInfo.inputChannels ?? "?"} ch`} />
                  <DeviceRow
                    label="Buffer 범위"
                    value={
                      deviceInfo.bufferRange
                        ? `${deviceInfo.bufferRange.min} ~ ${deviceInfo.bufferRange.max} frames`
                        : "—"
                    }
                  />
                  <DeviceRow
                    label="지원 SR"
                    value={
                      deviceInfo.supportedSampleRates?.length
                        ? deviceInfo.supportedSampleRates.map((r) => r / 1000).join(", ") + " kHz"
                        : "—"
                    }
                  />
                </dl>
              )}
              <p className="text-[10px] text-iron-300 leading-relaxed">
                ⚠️ Buffer Size는 per-client(TN2321)라 이 조회만으로는 장치 기본값이 보입니다.
                "적용"을 누르면 마이크를 아주 잠깐 열었다 닫아 실제 반영값을 확인합니다(마이크가
                이미 녹음 중이면 적용에 실패합니다).
              </p>
            </section>
          )}

          {/* INPUT DEVICE — 네이티브(Swift/CoreAudio) 입력 장치에 적용할 캡처 설정.
              query()로 받은 지원 SampleRate/Buffer 범위로 옵션을 구성하고, "적용" 시 capture
              probe(짧게 열었다 닫기)로 실제 장치에 반영·확인한다(브라우저에서는 데모 목록).
              Buffer는 per-client(TN2321)라 이 probe로만 실제 반영값을 확인할 수 있으며, 결과는
              아래 상태 문구로 표시한다. */}
          <section className="space-y-3">
            <h4 className="text-xs font-semibold text-iron-500">DEVICE</h4>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="Sample Rate"
                unit="Hz"
                value={draft.sampleRate}
                options={sampleRateOptions}
                onChange={(v) => set({ sampleRate: v })}
              />
              <SelectField
                label="Buffer Size"
                value={draft.bufferSize}
                options={bufferSizeOptions}
                onChange={(v) => set({ bufferSize: v })}
              />
            </div>
            {hasAudioDeviceBridge && (
              <SelectField
                label="Capture Channels (네이티브 캡처)"
                unit="ch"
                value={draft.channels}
                options={CHANNEL_OPTIONS}
                onChange={(v) => set({ channels: v })}
              />
            )}
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
