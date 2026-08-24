"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Play, Square } from "lucide-react";
import SideDrawer from "@/shared/components/overlay/SideDrawer";
import LabeledField from "@/shared/components/ui/LabeledField";
import { useDrawerState } from "@/features/audio/components/ActiveDrawerContext";
import { useEscapeKey } from "@/shared/hooks/useGlobalKey";
import { useCalibration } from "@/features/audio/components/calibration/CalibrationContext";
import { downloadBlob } from "@/shared/lib/utils";
import { clampCaptureChannels } from "@/features/audio/lib/engine/core";
import {
  LOOPBACK_DEFAULTS,
  LoopbackCancelledError,
  type BurstInvalidReason,
  type LoopbackConfig,
  type LoopbackPhase,
  type LoopbackReport,
} from "@/features/audio/lib/loopback/types";
import { validateLoopbackConfig } from "@/features/audio/lib/loopback/stimulus";
import { startLoopbackMeasurement, type LoopbackRunHandle } from "@/features/audio/lib/loopback/run";

const INVALID_REASON_LABEL: Record<BurstInvalidReason, string> = {
  "low-correlation": "no match",
  "window-edge": "≥ window",
  "capture-short": "stream short",
};

const PHASE_LABEL: Record<LoopbackPhase, string> = {
  uploading: "Uploading stimulus…",
  capturing: "Capturing…",
  analyzing: "Analyzing (matched filter)…",
};

interface BurstDraft {
  burstCount: string;
  burstFreqHz: string;
  burstMs: string;
  amplitudePct: string;
  maxLatencyMs: string;
}

const DRAFT_DEFAULTS: BurstDraft = {
  burstCount: String(LOOPBACK_DEFAULTS.burstCount),
  burstFreqHz: String(LOOPBACK_DEFAULTS.burstFreqHz),
  burstMs: String(LOOPBACK_DEFAULTS.burstMs),
  amplitudePct: String(LOOPBACK_DEFAULTS.amplitude * 100),
  maxLatencyMs: String(LOOPBACK_DEFAULTS.maxLatencyMs),
};

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
    <LabeledField label={label}>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-iron-200 bg-white focus-within:border-brand-blue focus-within:ring-1 focus-within:ring-brand-blue">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="w-full min-w-0 font-mono text-sm text-iron-900 bg-transparent focus:outline-none disabled:text-iron-400"
        />
        {unit && <span className="text-xs text-iron-400 shrink-0">{unit}</span>}
      </div>
    </LabeledField>
  );
}

function SummaryStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-iron-200 bg-iron-50/60 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wider font-medium text-iron-400">{label}</span>
      <span className="font-mono text-sm font-semibold text-iron-900 tabular-nums">{value}</span>
      {sub && <span className="font-mono text-[11px] text-iron-500 tabular-nums">{sub}</span>}
    </div>
  );
}

function IntegrityRow({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
      <span className="text-iron-400 shrink-0">{label}</span>
      <span className="flex items-center gap-1.5 font-mono text-iron-700 text-right break-all tabular-nums">
        {detail}
        {ok !== null && (
          <span className={ok ? "text-emerald-600" : "text-red-600"}>{ok ? "✓" : "✗"}</span>
        )}
      </span>
    </div>
  );
}

function fmt(v: number | null | undefined, digits: number): string {
  return v === null || v === undefined ? "—" : v.toFixed(digits);
}

function ResultSection({ report }: { report: LoopbackReport }) {
  const { integrity, stats } = report;
  const best = report.bestChannel !== null
    ? report.channels.find((c) => c.channel === report.bestChannel) ?? null
    : null;

  const saveJson = () => {
    const stamp = report.startedAtIso.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    void downloadBlob(blob, `hw-loopback_${stamp}.json`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-sm font-bold text-iron-900">Result</h3>
        <button
          type="button"
          onClick={saveJson}
          className="flex items-center gap-1.5 rounded-lg border border-iron-200 px-2.5 py-1.5 text-xs font-medium text-iron-600 transition hover:border-iron-400 hover:text-iron-900"
        >
          <Download className="w-3.5 h-3.5" /> JSON
        </button>
      </div>

      {stats ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <SummaryStat
              label="Round-trip (median)"
              value={`${fmt(stats.medianMs, 3)} ms`}
              sub={`${fmt(stats.medianSamples, 2)} smp @ ${integrity.actualSampleRate} Hz`}
            />
            <SummaryStat
              label="Jitter (max−min)"
              value={`${fmt(stats.spreadMs, 3)} ms`}
              sub={`${fmt(stats.spreadSamples, 2)} smp · σ ${fmt(stats.stdSamples, 2)} smp`}
            />
            <SummaryStat
              label="Mean"
              value={`${fmt(stats.meanMs, 3)} ms`}
              sub={`min ${fmt(stats.minSamples, 2)} · max ${fmt(stats.maxSamples, 2)} smp`}
            />
            <SummaryStat
              label="Valid bursts"
              value={`${stats.validCount} / ${report.config.burstCount}`}
              sub={`best channel ch${report.bestChannel}`}
            />
          </div>
          {stats.spreadSamples >= 1 && (
            <p className="m-0 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
              Burst-to-burst spread is ≥ 1 sample. On a single-clock duplex rig the round-trip should be
              sample-stable — check the wiring, or look for dropped stream data in the integrity list.
            </p>
          )}
        </>
      ) : (
        <p className="m-0 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
          No burst was detected on any capture channel. Check that the device output (ch{report.config.outputChannel}
          /{report.config.outputChannel + 1}) is physically looped back into the capture inputs, then retry.
        </p>
      )}

      <div>
        <h4 className="m-0 mb-1.5 text-xs font-semibold text-iron-500">Integrity</h4>
        <div className="rounded-lg border border-iron-200 bg-iron-50/60 divide-y divide-iron-100">
          <IntegrityRow
            label="Ref length echo"
            ok={integrity.refLenMatches}
            detail={`${integrity.refFramesEchoed ?? "—"} / ${integrity.refFramesSynthesized} fr`}
          />
          <IntegrityRow
            label="Stream framing"
            ok={integrity.trailingBytes === 0}
            detail={`${integrity.trailingBytes} B trailing`}
          />
          <IntegrityRow
            label="Burst coverage"
            ok={integrity.framesCoverAllBursts}
            detail={`${integrity.receivedFrames} ≥ ${integrity.coverageEndSample} fr`}
          />
          <IntegrityRow
            label="Stream loss guard"
            ok={integrity.framesReachRefEnd}
            detail={`${integrity.receivedFrames} ≥ ${integrity.refFramesSynthesized} fr`}
          />
          <IntegrityRow
            label="Sample rate"
            ok={integrity.sampleRateMatches}
            detail={`${integrity.actualSampleRate} Hz (req ${integrity.requestedSampleRate})`}
          />
          <IntegrityRow
            label="Buffer size"
            ok={null}
            detail={`${integrity.actualBufferSize ?? "?"} smp (req ${integrity.requestedBufferSize})`}
          />
          <IntegrityRow
            label="Playback out"
            ok={null}
            detail={`L ch${integrity.playbackChannelL ?? "?"} · R ${
              integrity.playbackChannelR === null ? "mono fallback" : `ch${integrity.playbackChannelR}`
            }`}
          />
          <IntegrityRow
            label="First chunk (wall, info only)"
            ok={null}
            detail={`${fmt(integrity.wallStartToFirstChunkMs, 1)} ms`}
          />
        </div>
      </div>

      {best && (
        <div>
          <h4 className="m-0 mb-1.5 text-xs font-semibold text-iron-500">Bursts — ch{best.channel}</h4>
          <div className="overflow-x-auto rounded-lg border border-iron-200">
            <table className="w-full text-[11px] font-mono tabular-nums">
              <thead>
                <tr className="bg-iron-50 text-iron-400">
                  <th className="px-2 py-1.5 text-left font-medium">#</th>
                  <th className="px-2 py-1.5 text-right font-medium">emit smp</th>
                  <th className="px-2 py-1.5 text-right font-medium">Δ smp</th>
                  <th className="px-2 py-1.5 text-right font-medium">Δ ms</th>
                  <th className="px-2 py-1.5 text-right font-medium">NCC</th>
                  <th className="px-2 py-1.5 text-right font-medium">state</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-iron-100">
                {best.detections.map((d) => (
                  <tr key={d.burstIndex} className={d.valid ? "text-iron-700" : "text-iron-400"}>
                    <td className="px-2 py-1">{d.burstIndex}</td>
                    <td className="px-2 py-1 text-right">{d.emissionSample}</td>
                    <td className="px-2 py-1 text-right">{fmt(d.latencySamples, 2)}</td>
                    <td className="px-2 py-1 text-right">{fmt(d.latencyMs, 3)}</td>
                    <td className="px-2 py-1 text-right">{d.peakNcc.toFixed(3)}</td>
                    <td className="px-2 py-1 text-right">
                      {d.valid ? "ok" : INVALID_REASON_LABEL[d.invalidReason ?? "low-correlation"]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {report.channels.length > 1 && (
        <div>
          <h4 className="m-0 mb-1.5 text-xs font-semibold text-iron-500">Channels</h4>
          <div className="overflow-x-auto rounded-lg border border-iron-200">
            <table className="w-full text-[11px] font-mono tabular-nums">
              <thead>
                <tr className="bg-iron-50 text-iron-400">
                  <th className="px-2 py-1.5 text-left font-medium">ch</th>
                  <th className="px-2 py-1.5 text-right font-medium">valid</th>
                  <th className="px-2 py-1.5 text-right font-medium">median smp</th>
                  <th className="px-2 py-1.5 text-right font-medium">mean NCC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-iron-100">
                {report.channels.map((c) => (
                  <tr
                    key={c.channel}
                    className={c.channel === report.bestChannel ? "bg-brand-blue/5 text-iron-900" : "text-iron-500"}
                  >
                    <td className="px-2 py-1">
                      ch{c.channel}
                      {c.channel === report.bestChannel ? " ★" : ""}
                    </td>
                    <td className="px-2 py-1 text-right">{c.validCount}/{c.detections.length}</td>
                    <td className="px-2 py-1 text-right">{fmt(c.medianLatencySamples, 2)}</td>
                    <td className="px-2 py-1 text-right">{c.meanPeakNcc.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function LoopbackDrawer({ sessionActive }: { sessionActive: boolean }) {
  const { open, setOpen } = useDrawerState("loopback");
  const { values: calibration } = useCalibration();
  useEscapeKey(() => setOpen(false), open);

  const [hasBridge, setHasBridge] = useState(false);
  useEffect(() => {
    setHasBridge(typeof window !== "undefined" && typeof window.audioPlayCapture !== "undefined");
  }, []);

  const [draft, setDraft] = useState<BurstDraft>(DRAFT_DEFAULTS);
  const setField = (key: keyof BurstDraft) => (v: string) => setDraft((d) => ({ ...d, [key]: v }));

  const [phase, setPhase] = useState<LoopbackPhase | null>(null);
  const [progress, setProgress] = useState<{ received: number; expected: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<LoopbackReport | null>(null);
  const handleRef = useRef<LoopbackRunHandle | null>(null);
  const running = phase !== null;

  useEffect(() => () => handleRef.current?.cancel(), []);

  const config = useMemo<LoopbackConfig>(
    () => ({
      sampleRate: Number(calibration.sampleRate),
      bufferSize: Number(calibration.bufferSize),
      channels: clampCaptureChannels(calibration.channels),
      captureDeviceUID: calibration.captureDeviceUID,
      outputChannel: Number(calibration.outputChannel) || 0,
      burstCount: Number(draft.burstCount),
      burstFreqHz: Number(draft.burstFreqHz),
      burstMs: Number(draft.burstMs),
      amplitude: Number(draft.amplitudePct) / 100,
      maxLatencyMs: Number(draft.maxLatencyMs),
      leadInMs: LOOPBACK_DEFAULTS.leadInMs,
      guardMs: LOOPBACK_DEFAULTS.guardMs,
      nccThreshold: LOOPBACK_DEFAULTS.nccThreshold,
    }),
    [calibration, draft],
  );
  const configErrors = useMemo(() => validateLoopbackConfig(config), [config]);

  const run = () => {
    if (running) return;
    setError(null);
    setReport(null);
    setProgress(null);
    setPhase("uploading");
    const handle = startLoopbackMeasurement(config, {
      onPhase: setPhase,
      onCaptureProgress: (received, expected) => setProgress({ received, expected }),
    });
    handleRef.current = handle;
    handle.promise
      .then(setReport)
      .catch((err: unknown) => {
        if (!(err instanceof LoopbackCancelledError)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        handleRef.current = null;
        setPhase(null);
        setProgress(null);
      });
  };

  const cancel = () => handleRef.current?.cancel();

  const canRun = hasBridge && !running && !sessionActive && configErrors.length === 0;
  const progressPct =
    progress && progress.expected > 0 ? Math.min(100, (progress.received / progress.expected) * 100) : 0;
  const captureSeconds = progress ? progress.received / (config.sampleRate || 48000) : 0;

  return (
    <SideDrawer
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="Loopback latency (dev)"
      title="Loopback"
      widthClassName="w-[520px] max-w-[94vw]"
      bodyClassName="p-4 flex flex-col gap-5"
    >
      <p className="m-0 rounded-lg bg-iron-50 px-3 py-2 text-xs leading-relaxed text-iron-500">
        Dev-only burst test: plays a Hann-windowed sine-burst train through the Capture Device&apos;s own
        output (single-IOProc play-capture) and matched-filters the captured stream. Round-trip latency is
        computed purely in the shared sample clock — <span className="font-semibold">detected arrival − known
        emission offset</span> — never from wall-clock time. Wire the device output (ch
        {config.outputChannel}/{config.outputChannel + 1}) back into its capture inputs (electrical loopback,
        or the V/I sense rig). <span className="font-semibold text-amber-600">Bursts go to the physical
        output — turn the amp down first.</span>
      </p>

      {!hasBridge && (
        <p className="m-0 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          The native play-capture bridge isn&apos;t available in a plain browser tab. Run the packaged
          --dev Tauri build (npm run build:tauri -- --mac --dev) to use this tool.
        </p>
      )}
      {sessionActive && (
        <p className="m-0 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          A dashboard playback/capture session is active — it owns the device. Stop it before measuring.
        </p>
      )}

      <div>
        <h3 className="m-0 mb-1.5 text-xs font-semibold text-iron-500">Session (from Calibration)</h3>
        <dl className="m-0 rounded-lg border border-iron-200 bg-iron-50/60 divide-y divide-iron-100 text-xs font-mono">
          <div className="flex items-start justify-between gap-3 px-3 py-1.5">
            <dt className="text-iron-400 shrink-0">Device</dt>
            <dd className="m-0 text-iron-700 text-right break-all">
              {calibration.captureDeviceUID.trim() || "OS default input"}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3 px-3 py-1.5">
            <dt className="text-iron-400 shrink-0">Capture</dt>
            <dd className="m-0 text-iron-700 text-right tabular-nums">
              {config.sampleRate} Hz · {config.bufferSize} smp · {config.channels} ch
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3 px-3 py-1.5">
            <dt className="text-iron-400 shrink-0">Output</dt>
            <dd className="m-0 text-iron-700 text-right tabular-nums">
              L ch{config.outputChannel} · R ch{config.outputChannel + 1} (best-effort)
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <h3 className="m-0 mb-1.5 text-xs font-semibold text-iron-500">Burst stimulus</h3>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Bursts" value={draft.burstCount} onChange={setField("burstCount")} disabled={running} />
          <NumberField label="Frequency" unit="Hz" value={draft.burstFreqHz} onChange={setField("burstFreqHz")} disabled={running} />
          <NumberField label="Burst length" unit="ms" value={draft.burstMs} onChange={setField("burstMs")} disabled={running} />
          <NumberField label="Amplitude" unit="%" value={draft.amplitudePct} onChange={setField("amplitudePct")} disabled={running} />
          <NumberField label="Search window" unit="ms" value={draft.maxLatencyMs} onChange={setField("maxLatencyMs")} disabled={running} />
        </div>
      </div>

      {configErrors.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
          {configErrors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        {!running ? (
          <button
            type="button"
            onClick={run}
            disabled={!canRun}
            className="flex items-center gap-2 rounded-lg bg-brand-blue px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play className="w-4 h-4" /> Measure
          </button>
        ) : (
          <button
            type="button"
            onClick={cancel}
            className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-100"
          >
            <Square className="w-4 h-4" /> Stop
          </button>
        )}
        {phase && (
          <span className="text-xs text-iron-500">
            {PHASE_LABEL[phase]}
            {phase === "capturing" && progress && (
              <span className="font-mono tabular-nums"> {captureSeconds.toFixed(1)} s</span>
            )}
          </span>
        )}
      </div>

      {phase === "capturing" && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-iron-100">
          <div
            className="h-full rounded-full bg-brand-blue transition-[width] duration-150"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {error && (
        <p className="m-0 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">{error}</p>
      )}

      {report && <ResultSection report={report} />}
    </SideDrawer>
  );
}

export default memo(LoopbackDrawer);
