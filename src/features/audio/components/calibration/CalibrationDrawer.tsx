"use client";

import { memo, useCallback, useEffect } from "react";
import { RefreshCw, RotateCcw, X } from "lucide-react";
import AnimatedSelect from "@/shared/components/ui/AnimatedSelect";
import DeviceSelectField from "./DeviceSelectField";
import { useActiveDrawer } from "@/features/audio/components/dashboard/ActiveDrawerContext";
import { CALIBRATION_EMPTY, useCalibration } from "./CalibrationContext";
import type { CalibrationValues } from "@/features/audio/types";
import { useNativeAudioDevice } from "./hooks/useNativeAudioDevice";
import { useMediaDevices } from "./hooks/useMediaDevices";
import { useDeviceOptionAutoCorrect } from "./hooks/useDeviceOptionAutoCorrect";
import { useCalibrationDraft } from "./hooks/useCalibrationDraft";
import { useCalibrationApply } from "./hooks/useCalibrationApply";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import SideDrawer from "@/shared/components/overlay/SideDrawer";
import LabeledField from "@/shared/components/ui/LabeledField";

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
    <LabeledField label={label}>
      <AnimatedSelect
        value={value}
        unit={unit}
        options={options.map((o) => ({ value: o }))}
        onChange={onChange}
        aria-label={label}
        disabled={disabled}
      />
    </LabeledField>
  );
}

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
    <LabeledField label={label}>
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
    </LabeledField>
  );
}

function DeviceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <dt className="text-iron-400 shrink-0">{label}</dt>
      <dd className="text-iron-700 text-right break-all">{value}</dd>
    </div>
  );
}

interface Props {
  projectName?: string | null;
  onApply?: (values: CalibrationValues) => void;
}

function CalibrationDrawer({ projectName, onApply }: Props) {
  const { values, setValues } = useCalibration();
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
    sampleRateOptions, bufferSizeOptions, channelOptions, outputChannelOptions, deviceOptionsLoading, adjustedNote, clearAdjustedNote,
  } = useDeviceOptionAutoCorrect({ deviceInfo, deviceInfoLoading, hasAudioDeviceBridge, draft, set });
  const {
    deviceStatus, deviceActual, deviceError, appliedRuntime, apply, resetStatus,
  } = useCalibrationApply({ draft, setValues, setOpen, hasAudioDeviceBridge, deviceInfo, refreshDeviceInfo, onApply });

  useEffect(() => {
    if (!open) return;
    resetStatus();
    clearAdjustedNote();
    refreshNativeDevices();
    refreshDeviceInfo(values.captureDeviceUID);
    refreshInputDevices();
  }, [open]);
  useEscapeKey(() => setOpen(false), open);

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
    <SideDrawer
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="Calibration Parameter"
      bodyClassName="p-4 space-y-5"
      header={
        <div className="h-14 px-4 shrink-0 flex items-center justify-between border-b border-iron-100">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="닫기"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      }
      footer={
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
      }
    >
          {projectName && (
            <div className="px-3 py-2 rounded-lg bg-brand-blue/5 text-xs text-brand-blue">
              대상: <span className="font-medium">{projectName}</span>
            </div>
          )}


          <section className="space-y-3">
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

            {hasMediaDevices && !hasAudioDeviceBridge && (
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
            {hasAudioDeviceBridge && (deviceInfo?.outputChannels ?? 0) > 0 && (
              <SelectField
                label="Output Channel (파일 재생)"
                unit="ch"
                value={draft.outputChannel}
                options={outputChannelOptions}
                onChange={(v) => { clearAdjustedNote(); set({ outputChannel: v }); }}
                disabled={deviceOptionsLoading}
              />
            )}
            {hasAudioDeviceBridge && (
              <div className="text-xs">
                {deviceStatus === "applying" && <p className="text-iron-400">디바이스에 적용 중…</p>}
                {deviceStatus === "applied" && (
                  <p className="text-emerald-600">
                    적용됨 — 요청 {draft.sampleRate}Hz/{draft.bufferSize}({draft.channels}ch) → 실제{" "}
                    {deviceActual?.sampleRate ?? "?"}Hz/{deviceActual?.bufferSize ?? "?"}{deviceActual?.channels ? `(${deviceActual.channels}ch)` : ""}
                  </p>
                )}
                {deviceStatus === "error" && <p className="text-red-500">디바이스 적용 실패: {deviceError}</p>}
              </div>
            )}
          </section>

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

              <DeviceSelectField
                label="Capture Device"
                aria-label="Capture Device"
                value={draft.captureDeviceUID}
                onChange={(uid) => {
                  set({ captureDeviceUID: uid });
                  refreshDeviceInfo(uid);
                }}
                devices={nativeDevices.map((d) => ({
                  value: d.uid,
                  label: d.name || "이름 없음",
                  hint: `${d.probed === false ? "사용 중" : `${d.inputChannels}ch`}${d.isDefault ? " · 기본" : ""}`,
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
                  <DeviceRow
                    label={appliedRuntime ? "현재(적용값)" : "현재(기본값)"}
                    value={
                      appliedRuntime
                        ? `${appliedRuntime.actual.sampleRate ?? "?"}Hz / ${appliedRuntime.actual.bufferSize ?? "?"} frames`
                        : `${deviceInfo.current?.sampleRate ?? "?"}Hz / ${deviceInfo.current?.bufferSize ?? "?"} frames`
                    }
                  />
                  <DeviceRow
                    label={appliedRuntime?.actual.channels != null ? "채널(적용값)" : "채널(기본값)"}
                    value={
                      appliedRuntime?.actual.channels != null
                        ? `${appliedRuntime.actual.channels} ch`
                        : `${deviceInfo.inputChannels ?? "?"} ch`
                    }
                  />
                  <DeviceRow
                    label="출력 채널"
                    value={deviceInfo.outputChannels != null ? `${deviceInfo.outputChannels} ch` : "—"}
                  />
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
              {deviceInfo?.outputChannels === 0 && (
                <p className="text-[11px] text-amber-600 leading-relaxed">
                  이 장치는 출력 채널이 없어 파일 재생(단일 IOProc 듀플렉스)이 불가합니다 —
                  마이크 모드만 사용할 수 있습니다.
                </p>
              )}
              <p className="text-[10px] text-iron-300 leading-relaxed">
                ⚠️ Buffer Size는 per-client(TN2321)라 이 조회만으로는 장치 기본값이 보입니다.
                &ldquo;적용&rdquo;을 누르면 마이크를 아주 잠깐 열었다 닫아 실제 반영값을 확인합니다(마이크가
                이미 녹음 중이면 적용에 실패합니다).
              </p>
            </section>
          )}
    </SideDrawer>
  );
}

export default memo(CalibrationDrawer);
