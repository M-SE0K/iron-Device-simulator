"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotOptions } from "@/shared/components/UPlotChart";
import { cn } from "@/shared/lib/utils";
import { INT16_SCALE, CHANNELS } from "@/features/audio/lib/engine/core";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import { buildTimeAxis, buildValueAxis, timeDecimalsForInterval } from "@/features/audio/lib/render/uplot-option";
import { staticSeriesLayerPlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import {
  BucketEnvelope,
  buildBucketXs,
  emptyEnvelopeColumn,
  fillEnvelopeColumn,
  type EnvelopeColumn,
} from "@/features/audio/lib/render/envelope";
import { peekWavHeader, decodeWavRange } from "@/features/audio/lib/codec/wav-incremental";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
import { frameScheduler } from "@/shared/lib/frame-scheduler";

const BUCKETS = 1000;
const Y_SCALE_PADDING = 1.1;

let panelTaskSeq = 0;
const Y_MIN_SPAN = 0.05;

type ChannelMode = "L" | "R" | "Both";

export const COLOR_INPUT_L     = "#93c5fd";
export const COLOR_PROTECTED_L = "#2563eb";
export const COLOR_INPUT_R     = "#fcd34d";
export const COLOR_PROTECTED_R = "#d97706";

function ProtectedComparePanelImpl({
  subscribeCaptureStream,
  sourceFile,
  getProtectedBlob,
  bare = false,
  hiddenSeries,
}: {
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
  sourceFile?: File | null;
  /**
   * 이미 캡처된 보호 감쇠 PCM(WAV)의 스냅샷. 패널이 세션 도중(재생이 이미 진행된 뒤)
   * 마운트돼도 지금까지의 "감쇠 후" 파형을 한 번 백필하기 위함 — 없으면 마운트 이후
   * 들어오는 라이브 프레임만 그려져 늦게 연 상세 뷰에서는 빈 파형으로 보인다.
   */
  getProtectedBlob?: () => Blob | null;
  bare?: boolean;
  /** 시리즈별(0=Input L, 1=Input R, 2=Protected L, 3=Protected R) on/off — View 탭이 소유한다. */
  hiddenSeries: Set<number>;
}) {
  const { showError } = useErrorPopup();
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");
  const [original, setOriginal] = useState<{ envL: BucketEnvelope; envR: BucketEnvelope; durationSec: number } | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);

  const protectedEnvRefs = useRef<[BucketEnvelope, BucketEnvelope]>([new BucketEnvelope(BUCKETS), new BucketEnvelope(BUCKETS)]);
  const sampleRateRef   = useRef(0);
  const [version, setVersion] = useState(0);

  const colsRef = useRef<{
    owner: object;
    xs: Float64Array;
    inputL: EnvelopeColumn;
    inputR: EnvelopeColumn;
    protL: [EnvelopeColumn, EnvelopeColumn];
    protR: [EnvelopeColumn, EnvelopeColumn];
    slot: 0 | 1;
    slotVersion: number;
  } | null>(null);

  const dirtyRef = useRef(false);
  const panelTaskIdRef = useRef<string | null>(null);
  if (panelTaskIdRef.current === null) panelTaskIdRef.current = `protected-compare#${++panelTaskSeq}`;

  useEffect(() => frameScheduler.register({
    id: panelTaskIdRef.current!,
    phase: "draw",
    isDirty: () => dirtyRef.current,
    run: () => {
      dirtyRef.current = false;
      setVersion((v) => v + 1);
    },
  }), []);

  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = original?.durationSec ?? 0; }, [original]);

  // 패널이 세션 도중 마운트됐을 때(상세 뷰에서 뒤늦게 "보호 감쇠" 항목을 선택하는 경우)
  // 백필이 끝나기 전까지 들어오는 라이브 프레임을 잃지 않도록 대기시킨다.
  type ProtectedEvent = Extract<CaptureStreamEvent, { type: "protected" }>;
  const pendingProtectedRef = useRef<ProtectedEvent[]>([]);
  const readyRef = useRef(false);
  // 백필 진행 중 세션이 리셋되면(재생 재시작 등) 오래된 백필 결과가 새 세션 데이터와
  // 섞이지 않도록 토큰으로 무효화한다.
  const backfillTokenRef = useRef(0);

  useEffect(() => {
    if (!sourceFile) {
      setOriginal(null);
      setDecodeError(null);
      return;
    }
    let cancelled = false;
    setDecoding(true);
    setDecodeError(null);

    (async () => {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        if (!cancelled) {
          setDecodeError("This browser doesn't support audio decoding.");
          showError("This browser doesn't support audio decoding.");
          setDecoding(false);
        }
        return;
      }
      const ctx = new Ctor();
      try {
        const buf = await ctx.decodeAudioData(await sourceFile.arrayBuffer());
        if (cancelled) return;
        const dataL = buf.getChannelData(0);
        const dataR = buf.getChannelData(Math.min(1, buf.numberOfChannels - 1));
        const envL = new BucketEnvelope(BUCKETS);
        const envR = new BucketEnvelope(BUCKETS);
        const n = dataL.length;
        for (let i = 0; i < n; i++) {
          const b = Math.min(BUCKETS - 1, Math.floor((i * BUCKETS) / n));
          envL.add(b, dataL[i]);
          envR.add(b, dataR[i]);
        }
        setOriginal({ envL, envR, durationSec: buf.duration });
      } catch {
        if (!cancelled) {
          setDecodeError("Failed to decode audio.");
          showError("Failed to decode audio.");
        }
      } finally {
        void ctx.close();
        if (!cancelled) setDecoding(false);
      }
    })();

    return () => { cancelled = true; };
  }, [sourceFile, showError]);

  useEffect(() => {
    protectedEnvRefs.current[0].clear();
    protectedEnvRefs.current[1].clear();
    colsRef.current = null;
    readyRef.current = false;
    pendingProtectedRef.current = [];
    backfillTokenRef.current += 1;
    setVersion((v) => v + 1);
  }, [sourceFile]);

  const applyProtectedEvent = useCallback((ev: ProtectedEvent, durationSec: number) => {
    sampleRateRef.current = ev.sampleRate;
    const [envL, envR] = protectedEnvRefs.current;
    const samplesPerFrame = ev.processed.length / CHANNELS;
    const base = ev.frameIndex * samplesPerFrame;
    const perBucketSec = durationSec / BUCKETS;

    for (let ch = 0; ch < CHANNELS; ch++) {
      const env = ch === 0 ? envL : envR;
      for (let i = ch, s = 0; i < ev.processed.length; i += CHANNELS, s++) {
        const t = (base + s) / ev.sampleRate;
        env.add(Math.floor(t / perBucketSec), ev.processed[i] / INT16_SCALE);
      }
    }

    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    if (!original) return;
    const token = ++backfillTokenRef.current;
    let cancelled = false;

    (async () => {
      if (getProtectedBlob) {
        try {
          const blob = getProtectedBlob();
          if (blob) {
            const header = await peekWavHeader(blob);
            if (header && !cancelled && backfillTokenRef.current === token) {
              const [dataL, dataR] = await Promise.all([
                decodeWavRange(blob, header, 0, 0, header.durationSec),
                decodeWavRange(blob, header, Math.min(1, header.channels - 1), 0, header.durationSec),
              ]);
              if (!cancelled && backfillTokenRef.current === token && dataL.length > 0) {
                const perBucketSec = original.durationSec / BUCKETS;
                const [envL, envR] = protectedEnvRefs.current;
                for (let s = 0; s < dataL.length; s++) {
                  const t = s / header.sampleRate;
                  const b = Math.floor(t / perBucketSec);
                  envL.add(b, dataL[s]);
                  envR.add(b, dataR[s]);
                }
              }
            }
          }
        } catch {
          // 백필 실패해도 라이브 스트림으로 계속 진행한다.
        }
      }
      if (cancelled || backfillTokenRef.current !== token) return;

      readyRef.current = true;
      const queued = pendingProtectedRef.current;
      pendingProtectedRef.current = [];
      if (queued.length > 0) {
        for (const ev of queued) applyProtectedEvent(ev, original.durationSec);
      } else {
        setVersion((v) => v + 1);
      }
    })();

    return () => { cancelled = true; };
  }, [original, getProtectedBlob, applyProtectedEvent]);

  useEffect(() => {
    const off = subscribeCaptureStream((ev: CaptureStreamEvent) => {
      if (ev.type === "reset") {
        protectedEnvRefs.current[0].clear();
        protectedEnvRefs.current[1].clear();
        colsRef.current = null;
        pendingProtectedRef.current = [];
        backfillTokenRef.current += 1;
        readyRef.current = true;
        setVersion((v) => v + 1);
        return;
      }
      if (ev.type !== "protected") return;

      if (!readyRef.current) {
        pendingProtectedRef.current.push(ev);
        return;
      }

      const durationSec = durationRef.current;
      if (durationSec <= 0) return;
      applyProtectedEvent(ev, durationSec);
    });

    return off;
  }, [subscribeCaptureStream, applyProtectedEvent]);

  const showL = channelMode !== "R";
  const showR = channelMode !== "L";

  const chartData = useMemo(() => {
    if (!original) return null;

    let cols = colsRef.current;
    if (!cols || cols.owner !== original) {
      cols = {
        owner: original,
        xs: buildBucketXs(BUCKETS, original.durationSec),
        inputL: fillEnvelopeColumn(original.envL),
        inputR: fillEnvelopeColumn(original.envR),
        protL: [emptyEnvelopeColumn(BUCKETS), emptyEnvelopeColumn(BUCKETS)],
        protR: [emptyEnvelopeColumn(BUCKETS), emptyEnvelopeColumn(BUCKETS)],
        slot: 0,
        slotVersion: version,
      };
      colsRef.current = cols;
    } else if (cols.slotVersion !== version) {
      cols.slot = cols.slot === 0 ? 1 : 0;
      cols.slotVersion = version;
    }

    const slot = cols.slot;
    const [protectedEnvL, protectedEnvR] = protectedEnvRefs.current;
    return [
      cols.xs,
      cols.inputL,
      cols.inputR,
      fillEnvelopeColumn(protectedEnvL, cols.protL[slot]),
      fillEnvelopeColumn(protectedEnvR, cols.protR[slot]),
    ] as unknown as uPlot.AlignedData;
  }, [original, version]);

  const yRange = useMemo<[number, number] | null>(() => {
    if (!original) return null;
    let peak = Y_MIN_SPAN;
    if (showL) peak = Math.max(peak, original.envL.peak());
    if (showR) peak = Math.max(peak, original.envR.peak());
    peak *= Y_SCALE_PADDING;
    return [-peak, peak];
  }, [original, showL, showR]);

  const options = useMemo<UPlotOptions | null>(() => {
    if (!original) return null;
    const timeDecimals = timeDecimalsForInterval(original.durationSec / BUCKETS);
    const inputSeries = (label: string, color: string): uPlot.Series => ({
      label, stroke: `${color}D9`, width: 1, spanGaps: true,
      paths: () => null,
      points: { show: false },
    });
    const protectedSeries = (label: string, color: string): uPlot.Series => ({
      label, stroke: color, width: 1.8, spanGaps: true, points: { size: 4, fill: color },
    });
    return {
      legend: { show: false },
      cursor: { drag: { x: true, y: false } },
      series: [
        {},
        inputSeries("Input L", COLOR_INPUT_L),
        inputSeries("Input R", COLOR_INPUT_R),
        protectedSeries("Protected L", COLOR_PROTECTED_L),
        protectedSeries("Protected R", COLOR_PROTECTED_R),
      ],
      axes: [
        buildTimeAxis(timeDecimals),
        buildValueAxis({ size: 56, formatter: (v: number) => v.toFixed(2) }),
      ],
      plugins: [
        staticSeriesLayerPlugin([1, 2]),
        zoomPlugin({ getFullXRange: () => [0, original.durationSec] }),
        tooltipPlugin({ unit: "", decimals: 3, timeDecimals: 3 }),
      ],
    };
  }, [original]);

  const seriesShow = useMemo(
    () => [
      showL && !hiddenSeries.has(0),
      showR && !hiddenSeries.has(1),
      showL && !hiddenSeries.has(2),
      showR && !hiddenSeries.has(3),
    ],
    [showL, showR, hiddenSeries],
  );

  const placeholder = decodeError
    ? "Unable to load original waveform."
    : (decoding ? "Preparing original waveform…" : null)
    ?? (!sourceFile ? "Select an audio source to see the original waveform." : null);

  return (
    <div id="protected-compare-panel" className={cn("flex flex-col h-full", !bare && "card")}>
      <div className={bare ? "flex items-center justify-between gap-2 px-1 pb-2 flex-wrap" : "card-header"}>
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">Protection Algorithm</span>
        </div>

        <SegmentedControl
          size="sm"
          value={channelMode}
          onChange={setChannelMode}
          options={[
            { value: "L", label: "L" },
            { value: "R", label: "R" },
            { value: "Both", label: "Both" },
          ]}
          className="w-[116px]"
          aria-label="Protected channel"
        />
      </div>

      <div className="chart-body flex-1 flex flex-col min-h-[160px] p-2">
        {options && chartData && yRange && !placeholder ? (
          <div className="flex-1 min-h-0">
            <UPlotChart
              options={options}
              data={chartData}
              yRange={yRange}
              xRange={[0, original!.durationSec]}
              seriesShow={seriesShow}
            />
          </div>
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            {placeholder ?? "Once analysis starts, the protected waveform will overlay here."}
          </div>
        )}
      </div>
    </div>
  );
}

export const ProtectedComparePanel = memo(ProtectedComparePanelImpl);
