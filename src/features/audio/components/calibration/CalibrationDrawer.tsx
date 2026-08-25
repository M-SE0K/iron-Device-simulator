"use client";

import { memo, useEffect } from "react";
import { RefreshCw, RotateCcw, X } from "lucide-react";
import AnimatedSelect from "@/shared/components/ui/AnimatedSelect";
import DeviceSelectField from "./DeviceSelectField";
import { useDrawerState } from "@/features/audio/components/ActiveDrawerContext";
import { CALIBRATION_EMPTY, useCalibration } from "./CalibrationContext";
import { useNativeAudioDevice } from "./hooks/useNativeAudioDevice";
import { useDeviceOptionAutoCorrect } from "./hooks/useDeviceOptionAutoCorrect";
import { useCalibrationDraft } from "./hooks/useCalibrationDraft";
import { useCalibrationApply } from "./hooks/useCalibrationApply";
import { useEscapeKey } from "@/shared/hooks/useGlobalKey";
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
  step,
  onChange,
}: {
  label: string;
  unit?: string;
  value: string;
  step?: string;
  onChange: (v: string) => void;
}) {
  return (
    <LabeledField label={label}>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-iron-200 bg-white focus-within:border-brand-blue focus-within:ring-1 focus-within:ring-brand-blue">
        <input
          type="number"
          inputMode="decimal"
          step={step}
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

function CalibrationDrawer() {
  const { values, setValues } = useCalibration();
  const { open, setOpen } = useDrawerState("calibration");
  const { draft, setDraft, set } = useCalibrationDraft(open, values);

  const {
    hasAudioDeviceBridge, deviceInfo, deviceInfoLoading, refreshDeviceInfo,
    nativeDevices, nativeDevicesLoading, refreshNativeDevices,
  } = useNativeAudioDevice(draft.captureDeviceUID);
  const {
    sampleRateOptions, bufferSizeOptions, channelOptions, deviceOptionsLoading, adjustedNote, clearAdjustedNote,
  } = useDeviceOptionAutoCorrect({ deviceInfo, deviceInfoLoading, hasAudioDeviceBridge, draft, set });
  const {
    deviceStatus, appliedRuntime, apply, resetStatus,
  } = useCalibrationApply({ draft, setValues, setOpen, hasAudioDeviceBridge, deviceInfo, refreshDeviceInfo });

  useEffect(() => {
    if (!open) return;
    resetStatus();
    clearAdjustedNote();
    refreshNativeDevices();
    refreshDeviceInfo(values.captureDeviceUID);
  }, [open]);
  useEscapeKey(() => setOpen(false), open);

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
            aria-label="Close"
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
            <RotateCcw className="w-4 h-4" /> Reset
          </button>
          <button
            type="button"
            onClick={apply}
            className="flex-1 px-3 py-2 rounded-lg text-sm text-white bg-brand-blue hover:bg-brand-blue/90"
          >
            Apply
          </button>
        </div>
      }
    >
          <section className="space-y-3">
            <h4 className="text-xs font-semibold text-iron-500">THRESHOLD</h4>
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Tmax"
                unit="°C"
                value={draft.tmax}
                onChange={(v) => set({ tmax: v })}
              />
              <NumberField
                label="Xmax"
                unit="mm"
                step="0.01"
                value={draft.xmax}
                onChange={(v) => set({ xmax: v })}
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
                  <RefreshCw className="w-3 h-3 animate-spin" /> Checking supported specs…
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
                label="Capture Channels"
                unit="ch"
                value={draft.channels}
                options={channelOptions}
                onChange={(v) => { clearAdjustedNote(); set({ channels: v }); }}
                disabled={deviceOptionsLoading}
              />
            )}
            {hasAudioDeviceBridge && (
              <div className="text-xs">
                {deviceStatus === "applying" && <p className="text-iron-400">Applying to device…</p>}
                {deviceStatus === "applied" && <p className="text-emerald-600">Applied.</p>}
                {deviceStatus === "error" && <p className="text-red-500">Device apply failed.</p>}
              </div>
            )}
          </section>

          {hasAudioDeviceBridge && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-iron-500">Connected Device</h4>
                <button
                  type="button"
                  onClick={() => { refreshNativeDevices(); refreshDeviceInfo(); }}
                  disabled={deviceInfoLoading || nativeDevicesLoading}
                  className="flex items-center gap-1 text-[11px] text-iron-400 hover:text-iron-700 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${deviceInfoLoading || nativeDevicesLoading ? "animate-spin" : ""}`} /> Refresh
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
                  label: d.name || "Unnamed",
                  hint: [
                    d.probed ? `${d.inputChannels}ch` : null,
                    d.isDefault ? "Default" : null,
                  ].filter(Boolean).join(" · ") || undefined,
                }))}
                placeholderLabel="OS Default Input"
                savedLabel="Saved Device"
              />

              {!deviceInfo && !deviceInfoLoading && (
                <p className="text-xs text-iron-300">Failed to load device info.</p>
              )}
              {deviceInfo && (
                <dl className="rounded-lg border border-iron-200 bg-iron-50/60 divide-y divide-iron-100 text-xs font-mono">
                  <DeviceRow label="Device" value={deviceInfo.device || "—"} />
                  <DeviceRow
                    label={appliedRuntime ? "Current (Applied)" : "Current (Default)"}
                    value={
                      appliedRuntime
                        ? `${appliedRuntime.actual.sampleRate ?? "?"}Hz / ${appliedRuntime.actual.bufferSize ?? "?"} frames`
                        : `${deviceInfo.current?.sampleRate ?? "?"}Hz / ${deviceInfo.current?.bufferSize ?? "?"} frames`
                    }
                  />
                  <DeviceRow
                    label={appliedRuntime?.actual.channels != null ? "Channels (Applied)" : "Channels (Default)"}
                    value={
                      appliedRuntime?.actual.channels != null
                        ? `${appliedRuntime.actual.channels} ch`
                        : `${deviceInfo.inputChannels ?? "?"} ch`
                    }
                  />
                  <DeviceRow
                    label="Output Channels"
                    value={deviceInfo.outputChannels != null ? `${deviceInfo.outputChannels} ch` : "—"}
                  />
                  <DeviceRow
                    label="Buffer Range"
                    value={
                      deviceInfo.bufferRange
                        ? `${deviceInfo.bufferRange.min} ~ ${deviceInfo.bufferRange.max} frames`
                        : "—"
                    }
                  />
                  <DeviceRow
                    label="Supported SR"
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
                  This device has no output channels, so file playback (single-IOProc duplex) is unavailable.
                </p>
              )}
              <p className="text-[10px] text-iron-300 leading-relaxed">
                ⚠️ Buffer Size is per-client (TN2321), so this query only shows the device default. Pressing “Apply” briefly opens and closes the microphone to confirm the actual applied value (this fails if the microphone is already recording).
              </p>
            </section>
          )}
    </SideDrawer>
  );
}

export default memo(CalibrationDrawer);
