"use client";

// 우측 슬라이딩 드로어 — 캘리브레이션 파라미터 편집(앱 전역 단일 소스).
// 값은 CalibrationProvider(Context)에 보관되어 대시보드 분석에 그대로 쓰인다("캘리브레이션 단일 적용").
// 편집은 로컬 draft 에서 하고 "적용" 시 Context 에 커밋한다.
//   · Input Source / Analysis Mode / Input·Output·Capture Device
//   · Sample Rate / Buffer Size / Capture Channels (+ 연결된 장치 능력 패널)
// 좌측 WorkspaceDrawer와 동일하게 항상 마운트된 순수 DOM(비Radix)로 구현 — open 불리언으로
// 클래스만 토글해 열기/닫기 양방향 슬라이드·페이드 애니메이션을 대칭적으로 재생한다.
import { useCallback, useEffect } from "react";
import { RefreshCw, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import AnimatedSelect from "@/shared/components/AnimatedSelect";
import DeviceSelectField from "./DeviceSelectField";
import { useActiveDrawer } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import {
  CALIBRATION_EMPTY,
  useCalibration,
  type CalibrationValues,
} from "./CalibrationContext";
import { useNativeAudioDevice } from "./hooks/useNativeAudioDevice";
import { useMediaDevices } from "./hooks/useMediaDevices";
import { useDeviceOptionAutoCorrect } from "./hooks/useDeviceOptionAutoCorrect";
import { useCalibrationDraft } from "./hooks/useCalibrationDraft";
import { useCalibrationApply } from "./hooks/useCalibrationApply";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";

/** 드롭다운 선택 필드 */
function SelectField({
  label,
  unit,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  unit?: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
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
        disabled={disabled}
      />
    </div>
  );
}

/** 숫자 자유 입력 필드 — 고정 옵션 목록이 없는 값(온도 임계값 등)용. AnimatedSelect 트리거와 톤을 맞췄다. */
function NumberField({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">{label}</label>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-iron-200 bg-white focus-within:border-brand-blue focus-within:ring-1 focus-within:ring-brand-blue">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="w-full min-w-0 font-mono text-sm text-iron-900 bg-transparent focus:outline-none"
        />
        {unit && <span className="text-xs text-iron-400 shrink-0">{unit}</span>}
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

export default function CalibrationDrawer({ projectName, onApply }: Props) {
  const { values, setValues } = useCalibration();
  // 우측 드로어 슬롯은 ActiveDrawerContext가 배타적으로 관리한다 — open은 그 파생값.
  // (입력 소스(파일/마이크) 토글은 대시보드 상단 세그먼트 컨트롤로 이동했다.)
  const activeDrawer = useActiveDrawer();
  const open = activeDrawer.active === "calibration";
  const setOpen = useCallback(
    (v: boolean) => (v ? activeDrawer.openDrawer("calibration") : activeDrawer.closeDrawer()),
    [activeDrawer],
  );
  const { draft, setDraft, set } = useCalibrationDraft(open, values);

  const {
    hasAudioDeviceBridge, deviceInfo, deviceInfoLoading, refreshDeviceInfo,
    nativeDevices, nativeDevicesLoading, refreshNativeDevices,
  } = useNativeAudioDevice(draft.captureDeviceUID);
  const {
    hasMediaDevices, inputDevices, outputDevices, devicesLoading, labelsHidden,
    refreshInputDevices, revealDeviceNames,
  } = useMediaDevices();
  const {
    sampleRateOptions, bufferSizeOptions, channelOptions, deviceOptionsLoading, adjustedNote, clearAdjustedNote,
  } = useDeviceOptionAutoCorrect({ deviceInfo, deviceInfoLoading, hasAudioDeviceBridge, draft, set });
  const {
    deviceStatus, deviceActual, deviceError, appliedRuntime, apply, resetStatus,
  } = useCalibrationApply({ draft, setValues, setOpen, hasAudioDeviceBridge, deviceInfo, refreshDeviceInfo, onApply });

  // 열 때마다 적용상태/adjustedNote 리셋 + 장치 정보 새로고침 (draft 자체의 동기화는 useCalibrationDraft가 별도 [open] effect로 담당 — React는 같은 의존성의 effect 여러 개를 선언 순서대로 전부 실행하므로 하나였을 때와 동작이 같다).
  useEffect(() => {
    if (!open) return;
    resetStatus();
    clearAdjustedNote();
    refreshNativeDevices();
    refreshDeviceInfo(values.captureDeviceUID);
    refreshInputDevices();
  }, [open]);
  useEscapeKey(() => setOpen(false), open);

  // Input/Output Device 헤더의 새로고침 버튼 — 동작이 완전히 동일해 하나로 공유한다.
  const refreshDevicesButton = (
    <button
      type="button"
      onClick={labelsHidden ? revealDeviceNames : refreshInputDevices}
      disabled={devicesLoading}
      className="flex items-center gap-1 text-[11px] text-iron-400 hover:text-iron-700 disabled:opacity-50"
    >
      <RefreshCw className={`w-3 h-3 ${devicesLoading ? "animate-spin" : ""}`} />
      {labelsHidden ? "이름 표시" : "새로고침"}
    </button>
  );

  return (
    <>
      {/* 배경 오버레이 — content-column 기준(사이드바는 백드롭 아래에서도 클릭 가능) */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`absolute inset-0 z-40 bg-iron-900/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 우측 슬라이딩 패널 */}
      <aside
        className={`absolute top-0 right-0 z-50 h-full w-[320px] max-w-[82vw] bg-white border-l border-iron-100 shadow-[-12px_0_40px_rgba(15,23,42,0.16)] flex flex-col transition-transform duration-[240ms] ease-out ${
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

          {/* 입력 소스(파일/마이크) 토글은 대시보드 상단 세그먼트 컨트롤로 이동했다 — 여기서는 제거. */}

          {/* 기본 입력 */}
          <section className="space-y-3">
            {/* 입력 장치 — 웹/모바일(getUserMedia) 전용. Electron에서는 아래 "연결된 장치"의
                Capture Device(CoreAudio UID)가 캡처 대상을 담당하므로 이 선택기는 숨긴다(중복 방지). */}
            {hasMediaDevices && !hasAudioDeviceBridge && (
              <DeviceSelectField
                label="Input Device"
                aria-label="Input Device"
                value={draft.inputDeviceId}
                onChange={(id) => {
                  const dev = inputDevices.find((d) => d.deviceId === id);
                  set({ inputDeviceId: id, inputDeviceLabel: dev?.label ?? "" });
                }}
                devices={inputDevices.map((d, i) => ({
                  value: d.deviceId,
                  label: d.label || `마이크 ${i + 1}`,
                }))}
                placeholderLabel="시스템 기본 입력"
                savedLabel={draft.inputDeviceLabel || "저장된 장치"}
                headerRight={refreshDevicesButton}
                footnote={labelsHidden && (
                  <p className="text-[10px] text-iron-300 leading-relaxed">
                    마이크 권한을 허용하면 장치 이름이 표시됩니다.
                  </p>
                )}
              />
            )}

            {/* 출력 장치 — 재생을 어느 출력으로 보낼지(WaveSurfer setSinkId). 입력과 달리 웹·Electron
                양쪽 모두 노출한다(setSinkId는 표준 웹 API라 CoreAudio 헬퍼가 필요 없다). V/I 센싱
                루프에서 음원을 앰프/스피커(예: MCHStreamer 출력)로 라우팅하는 데 쓴다. */}
            {hasMediaDevices && (
              <DeviceSelectField
                label="Output Device"
                aria-label="Output Device"
                value={draft.outputDeviceId}
                onChange={(id) => {
                  const dev = outputDevices.find((d) => d.deviceId === id);
                  set({ outputDeviceId: id, outputDeviceLabel: dev?.label ?? "" });
                }}
                devices={outputDevices.map((d, i) => ({
                  value: d.deviceId,
                  label: d.label || `출력 ${i + 1}`,
                }))}
                placeholderLabel="시스템 기본 출력"
                savedLabel={draft.outputDeviceLabel || "저장된 장치"}
                headerRight={refreshDevicesButton}
                footnote={(
                  <p className="text-[10px] text-iron-300 leading-relaxed">
                    재생 오디오를 보낼 출력 장치입니다. V/I 센싱 시 앰프/스피커가 물린 출력을 선택하세요.
                  </p>
                )}
              />
            )}
          </section>

          {/* 온도 임계값 — TemperatureChart의 WARN/DANGER markLine과 렌더 이벤트 감지(detectEvents)가
              공유한다. 값이 비어있거나 숫자가 아니면 기본값(65/75°C)으로 fallback.
              Ambient Temp는 임계값이 아니라 ff_prot_start_exec에 그대로 전달되는 엔진 입력값이다
              (미설정/숫자 아님 시 기본값 25°C로 fallback, engine/protocol/analysis.ts parseEngineParams). */}
          <section className="space-y-3">
            <h4 className="text-xs font-semibold text-iron-500">THRESHOLD</h4>
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Temp WARN"
                unit="°C"
                value={draft.tempWarn}
                onChange={(v) => set({ tempWarn: v })}
              />
              <NumberField
                label="Temp DANGER"
                unit="°C"
                value={draft.tempDanger}
                onChange={(v) => set({ tempDanger: v })}
              />
              <NumberField
                label="Ambient Temp"
                unit="°C"
                value={draft.ambientTemp}
                onChange={(v) => set({ ambientTemp: v })}
              />
            </div>
          </section>

          {/* INPUT DEVICE — 네이티브(Swift/CoreAudio) 입력 장치에 적용할 캡처 설정.
              query()로 받은 지원 SampleRate/Buffer 범위로 옵션을 구성하고, "적용" 시 capture
              probe(짧게 열었다 닫기)로 실제 장치에 반영·확인한다(브라우저에서는 데모 목록).
              Buffer는 per-client(TN2321)라 이 probe로만 실제 반영값을 확인할 수 있으며, 결과는
              아래 상태 문구로 표시한다. */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold text-iron-500">DEVICE</h4>
              {deviceOptionsLoading && (
                <span className="flex items-center gap-1 text-[10px] text-iron-400">
                  <RefreshCw className="w-3 h-3 animate-spin" /> 지원 규격 확인 중…
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="Sample Rate"
                unit="Hz"
                value={draft.sampleRate}
                options={sampleRateOptions}
                onChange={(v) => { clearAdjustedNote(); set({ sampleRate: v }); }}
                disabled={deviceOptionsLoading}
              />
              <SelectField
                label="Buffer Size"
                value={draft.bufferSize}
                options={bufferSizeOptions}
                onChange={(v) => { clearAdjustedNote(); set({ bufferSize: v }); }}
                disabled={deviceOptionsLoading}
              />
            </div>
            {/* 장치 미지원 값이 지원값으로 자동 보정됐을 때의 안내 — 사용자가 직접 다시 고르거나
                드로어를 다시 열면 사라진다. */}
            {adjustedNote && !deviceOptionsLoading && (
              <p className="text-[11px] text-amber-600 leading-relaxed">⚠️ {adjustedNote}</p>
            )}
            {hasAudioDeviceBridge && (
              <SelectField
                label="Capture Channels (네이티브 캡처)"
                unit="ch"
                value={draft.channels}
                options={channelOptions}
                onChange={(v) => { clearAdjustedNote(); set({ channels: v }); }}
                disabled={deviceOptionsLoading}
              />
            )}
            {/* "적용" 시 capture probe(TN2321)로 확인한 실제 하드웨어 반영값 — CoreAudio가
                돌려준 SampleRate/Buffer 를 요청값과 나란히 보여준다. */}
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

          {/* 연결된 장치 정보 (Electron 전용) */}
          {hasAudioDeviceBridge && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-iron-500">연결된 장치</h4>
                <button
                  type="button"
                  onClick={() => { refreshNativeDevices(); refreshDeviceInfo(); }}
                  disabled={deviceInfoLoading || nativeDevicesLoading}
                  className="flex items-center gap-1 text-[11px] text-iron-400 hover:text-iron-700 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${deviceInfoLoading || nativeDevicesLoading ? "animate-spin" : ""}`} /> 새로고침
                </button>
              </div>

              {/* 캡처 대상 장치 선택 — CoreAudio UID로 특정 장치를 골라 query/capture를 그 장치로 라우팅.
                  선택은 draft.captureDeviceUID에 저장되어 "적용" 시 MicrophonePlayer의 네이티브 캡처 대상이 된다. */}
              <DeviceSelectField
                label="Capture Device"
                aria-label="Capture Device"
                value={draft.captureDeviceUID}
                onChange={(uid) => {
                  set({ captureDeviceUID: uid });
                  refreshDeviceInfo(uid); // 선택 즉시 그 장치의 능력으로 아래 패널을 갱신
                }}
                devices={nativeDevices.map((d) => ({
                  value: d.uid,
                  label: d.name || "이름 없음",
                  hint: `${d.inputChannels}ch${d.isDefault ? " · 기본" : ""}`,
                }))}
                placeholderLabel="OS 기본 입력"
                savedLabel="저장된 장치"
              />

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
