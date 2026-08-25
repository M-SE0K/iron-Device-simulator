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
  type LoopbackPath,
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

const PATH_META: Record<LoopbackPath, { label: string; sub: string; blurb: string }> = {
  ref: {
    label: "Hardware",
    sub: "--ref",
    blurb:
      "The whole stimulus is pre-uploaded and the helper indexes it with a play position that advances " +
      "unconditionally every callback. Emission and capture timelines are identical, so the result is the " +
      "pure hardware round-trip.",
  },
  stream: {
    label: "Stream path",
    sub: "--stream",
    blurb:
      "The stimulus is pushed frame-by-frame into the helper's stdin ring — the same path Protected playback " +
      "uses. A starved ring emits silence without advancing the read position, so the measured value is the " +
      "hardware round-trip PLUS accumulated underrun. Subtract a --ref run on the same rig to read the " +
      "underrun off directly.",
  },
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
  const isStream = integrity.path === "stream";
  const best = report.bestChannel !== null
    ? report.channels.find((c) => c.channel === report.bestChannel) ?? null
    : null;

  const saveJson = () => {
    const stamp = report.startedAtIso.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    void downloadBlob(blob, `hw-loopback_${integrity.path}_${stamp}.json`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-sm font-bold text-iron-900">
          Result <span className="font-mono text-xs font-normal text-iron-400">{PATH_META[integrity.path].sub}</span>
        </h3>
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
              label={isStream ? "Stream path (median)" : "Round-trip (median)"}
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
              {isStream ? (
                <>
                  Burst-to-burst spread is ≥ 1 sample. On the stream path this is the expected signature of a
                  starving playback ring — read the burst table below: each step up in Δ smp is an underrun,
                  and where it steps is when it happened.
                </>
              ) : (
                <>
                  Burst-to-burst spread is ≥ 1 sample. On a single-clock duplex rig the round-trip should be
                  sample-stable — check the wiring, or look for dropped stream data in the integrity list.
                </>
              )}
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
          {isStream ? (
            <>
              <IntegrityRow
                label="Stimulus streamed"
                ok={integrity.sentAllFrames}
                detail={`${integrity.sentFrames ?? "—"} / ${integrity.refFramesSynthesized} fr`}
              />
              <IntegrityRow
                label="Prefill gate"
                ok={null}
                detail={`${integrity.prefillFramesEchoed ?? "—"} fr`}
              />
            </>
          ) : (
            <IntegrityRow
              label="Ref length echo"
              ok={integrity.refLenMatches}
              detail={`${integrity.refFramesEchoed ?? "—"} / ${integrity.refFramesSynthesized} fr`}
            />
          )}
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
            label="Helper mode"
            ok={integrity.helperMode === (isStream ? "play-capture-stream" : "play-capture")}
            detail={integrity.helperMode ?? "—"}
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

/** 두 경로를 나란히 뺀 값 — 같은 리그에서 stream − ref 가 곧 재생 링 언더런 누계다.
 * 헬퍼는 언더런을 종료 시 stderr 로만 보고하고 streaming.rs 가 그 stderr 를 버리므로,
 * 이 차이가 현재 언더런을 샘플 단위로 보는 유일한 창이다. */
function PathComparison({ refReport, streamReport }: { refReport: LoopbackReport; streamReport: LoopbackReport }) {
  const base = refReport.stats;
  const stream = streamReport.stats;
  if (!base || !stream) return null;

  const rateMismatch = refReport.integrity.actualSampleRate !== streamReport.integrity.actualSampleRate;
  const layoutMismatch =
    refReport.stimulus.totalFrames !== streamReport.stimulus.totalFrames ||
    refReport.stimulus.burstLenSamples !== streamReport.stimulus.burstLenSamples;
  const deltaSamples = stream.medianSamples - base.medianSamples;
  const deltaMs = stream.medianMs - base.medianMs;
  const clean = Math.abs(deltaSamples) < 1;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-iron-200 bg-white p-3">
      <h3 className="m-0 text-sm font-bold text-iron-900">Stream vs hardware</h3>
      <div className="grid grid-cols-3 gap-2">
        <SummaryStat label="Hardware (--ref)" value={`${fmt(base.medianMs, 3)} ms`} sub={`${fmt(base.medianSamples, 2)} smp`} />
        <SummaryStat label="Stream (--stream)" value={`${fmt(stream.medianMs, 3)} ms`} sub={`${fmt(stream.medianSamples, 2)} smp`} />
        <SummaryStat
          label="Ring underrun"
          value={`${deltaMs >= 0 ? "+" : ""}${fmt(deltaMs, 3)} ms`}
          sub={`${deltaSamples >= 0 ? "+" : ""}${fmt(deltaSamples, 2)} smp`}
        />
      </div>
      {rateMismatch || layoutMismatch ? (
        <p className="m-0 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          The two runs used different {rateMismatch ? "sample rates" : "stimulus layouts"} — re-run both with the
          same settings before reading the difference as underrun.
        </p>
      ) : (
        <p className="m-0 text-xs leading-relaxed text-iron-500">
          {clean
            ? "The stream path added no measurable delay — the playback ring never starved on this run."
            : "The stream path lags the hardware baseline by that much. Frames are never dropped (a starved ring emits silence without advancing its read position), so the whole difference is accumulated playback-ring underrun."}
        </p>
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

  const [path, setPath] = useState<LoopbackPath>(LOOPBACK_DEFAULTS.path);
  const [phase, setPhase] = useState<LoopbackPhase | null>(null);
  const [progress, setProgress] = useState<{ received: number; expected: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* 두 경로의 결과를 각각 들고 있어야 stream − ref 비교가 성립한다 — 경로를 바꿔도 반대편
   * 결과는 남는다. */
  const [reports, setReports] = useState<Record<LoopbackPath, LoopbackReport | null>>({ ref: null, stream: null });
  const report = reports[path];
  const handleRef = useRef<LoopbackRunHandle | null>(null);
  const running = phase !== null;

  useEffect(() => () => handleRef.current?.cancel(), []);

  const config = useMemo<LoopbackConfig>(
    () => ({
      path,
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
    [calibration, draft, path],
  );
  const configErrors = useMemo(() => validateLoopbackConfig(config), [config]);

  const run = () => {
    if (running) return;
    setError(null);
    setReports((prev) => ({ ...prev, [path]: null }));
    setProgress(null);
    setPhase(path === "ref" ? "uploading" : "capturing");
    const handle = startLoopbackMeasurement(config, {
      onPhase: setPhase,
      onCaptureProgress: (received, expected) => setProgress({ received, expected }),
    });
    handleRef.current = handle;
    handle.promise
      .then((result) => setReports((prev) => ({ ...prev, [path]: result })))
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
        output (single-IOProc play-capture) and matched-filters the captured stream. Latency is computed purely
        in the shared sample clock — <span className="font-semibold">detected arrival − known emission
        offset</span> — never from wall-clock time. Wire the device output (ch
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
        <h3 className="m-0 mb-1.5 text-xs font-semibold text-iron-500">Playback path</h3>
        <div className="grid grid-cols-2 gap-2">
          {(["ref", "stream"] as const).map((key) => {
            const active = path === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPath(key)}
                disabled={running}
                aria-pressed={active}
                className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? "border-brand-blue bg-brand-blue/5 text-iron-900"
                    : "border-iron-200 bg-white text-iron-500 hover:border-iron-400"
                }`}
              >
                <span className="text-xs font-semibold">{PATH_META[key].label}</span>
                <span className="font-mono text-[11px] text-iron-400">{PATH_META[key].sub}</span>
                {reports[key] && (
                  <span className="font-mono text-[11px] tabular-nums text-iron-500">
                    {fmt(reports[key]?.stats?.medianMs ?? null, 3)} ms
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="m-0 mt-1.5 text-xs leading-relaxed text-iron-500">{PATH_META[path].blurb}</p>
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

      {reports.ref?.stats && reports.stream?.stats && (
        <PathComparison refReport={reports.ref} streamReport={reports.stream} />
      )}

      {report && <ResultSection report={report} />}
    </SideDrawer>
  );
}

export default memo(LoopbackDrawer);
