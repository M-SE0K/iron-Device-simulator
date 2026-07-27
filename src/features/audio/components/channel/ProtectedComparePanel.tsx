"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "@/shared/components/ReactECharts";
import { cn } from "@/shared/lib/utils";
import { INT16_SCALE, CHANNELS } from "@/features/audio/lib/engine/core";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import {
  buildValueTooltip, buildDataZoom, buildDynamicTimeFormatter,
  extractZoomState, timeDecimalsForInterval, shouldShowFrameSymbols, type ZoomStateRef,
} from "@/features/audio/lib/render/chart-option";
import { peekWavHeader, decodeWavRange } from "@/features/audio/lib/codec/wav-incremental";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/useCaptureSession";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";

const BUCKETS = 1000;
const FLUSH_INTERVAL_MS = 50;
const Y_SCALE_PADDING = 1.1;
const Y_MIN_SPAN = 0.05;

type ChannelMode = "L" | "R" | "Both";

// 채널 정체성은 색상(hue)으로, Input/Protected 구분은 스타일(옅은 점선 vs 굵은 실선)로 —
// 예전엔 Input L/R이 둘 다 무채색(회색 계열)이라 서로 거의 구분이 안 됐다. 지금은 L=파랑,
// R=주황 계열을 Input까지 일관되게 써서, Both 모드에서도 어느 라인이 어느 채널인지 색만
// 보고 바로 알 수 있게 한다.
const COLOR_INPUT_L     = "#93c5fd"; // blue-300 (옅음 — 원본 참고선)
const COLOR_PROTECTED_L = "#2563eb"; // blue-600 (진함 — 보호 감쇠 후 신호)
const COLOR_INPUT_R     = "#fcd34d"; // amber-300 (옅음 — 원본 참고선)
const COLOR_PROTECTED_R = "#d97706"; // amber-600 (진함 — 보호 감쇠 후 신호)

class BucketEnvelope {
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly seen: Uint8Array;
  filledUpTo = -1;

  constructor(readonly buckets: number) {
    this.min = new Float32Array(buckets);
    this.max = new Float32Array(buckets);
    this.seen = new Uint8Array(buckets);
  }

  add(bucket: number, v: number) {
    if (bucket < 0 || bucket >= this.buckets) return;
    if (this.seen[bucket] === 0) {
      this.min[bucket] = v;
      this.max[bucket] = v;
      this.seen[bucket] = 1;
      if (bucket > this.filledUpTo) this.filledUpTo = bucket;
      return;
    }
    if (v < this.min[bucket]) this.min[bucket] = v;
    else if (v > this.max[bucket]) this.max[bucket] = v;
  }

  clear() {
    this.seen.fill(0);
    this.filledUpTo = -1;
  }

  peak(): number {
    let peak = 0;
    for (let b = 0; b <= this.filledUpTo; b++) {
      if (this.seen[b] === 0) continue;
      const a = Math.max(Math.abs(this.min[b]), Math.abs(this.max[b]));
      if (a > peak) peak = a;
    }
    return peak;
  }
}

function envelopeToSeries(env: BucketEnvelope, durationSec: number): [number, number][] {
  const dt = durationSec / env.buckets;
  const out: [number, number][] = [];
  for (let b = 0; b <= env.filledUpTo; b++) {
    if (env.seen[b] === 0) continue;
    const t = b * dt;
    out.push([t, env.min[b]], [t + dt * 0.5, env.max[b]]);
  }
  return out;
}

function ProtectedComparePanelImpl({
  subscribeCaptureStream,
  sourceFile,
  getProtectedBlob,
  bare = false,
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
}) {
  const { showError } = useErrorPopup();
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");
  const [original, setOriginal] = useState<{ envL: BucketEnvelope; envR: BucketEnvelope; durationSec: number } | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);

  const protectedEnvRefs = useRef<[BucketEnvelope, BucketEnvelope]>([new BucketEnvelope(BUCKETS), new BucketEnvelope(BUCKETS)]);
  const sampleRateRef   = useRef(0);
  const totalSamplesRef = useRef(0);
  const [version, setVersion] = useState(0);

  const rafRef       = useRef<number | null>(null);
  const dirtyRef     = useRef(false);
  const lastFlushRef = useRef(0);

  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = original?.durationSec ?? 0; }, [original]);

  const zoomRef: ZoomStateRef = useRef({ start: 0, end: 100 });
  const [showSymbols, setShowSymbols] = useState(false);
  const pointCountRef = useRef(0);

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
    totalSamplesRef.current = 0;
    zoomRef.current = { start: 0, end: 100 };
    setShowSymbols(false);
    readyRef.current = false;
    pendingProtectedRef.current = [];
    backfillTokenRef.current += 1;
    setVersion((v) => v + 1);
  }, [sourceFile]);

  const flush = useCallback(() => {
    rafRef.current = null;
    if (!dirtyRef.current) return;

    const now = performance.now();
    if (now - lastFlushRef.current < FLUSH_INTERVAL_MS) {
      rafRef.current = requestAnimationFrame(flush);
      return;
    }
    lastFlushRef.current = now;
    dirtyRef.current = false;
    setVersion((v) => v + 1);
  }, []);

  const applyProtectedEvent = useCallback((ev: ProtectedEvent, durationSec: number) => {
    sampleRateRef.current = ev.sampleRate;
    const [envL, envR] = protectedEnvRefs.current;
    const base = totalSamplesRef.current;
    const perBucketSec = durationSec / BUCKETS;

    for (let ch = 0; ch < CHANNELS; ch++) {
      const env = ch === 0 ? envL : envR;
      for (let i = ch, s = 0; i < ev.processed.length; i += CHANNELS, s++) {
        const t = (base + s) / ev.sampleRate;
        env.add(Math.floor(t / perBucketSec), ev.processed[i] / INT16_SCALE);
      }
    }
    totalSamplesRef.current = base + ev.processed.length / CHANNELS;

    dirtyRef.current = true;
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  // 원본 디코드가 끝나면(= x축 durationSec 확보) 지금까지 캡처된 보호 감쇠 PCM을 한 번
  // 백필한다 — getChannelsBlob 백필(ChartDetailOverlay)과 동일한 idiom. 백필이 끝나기
  // 전에 들어온 라이브 프레임은 pendingProtectedRef에 쌓아뒀다가 이어서 적용한다.
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
                totalSamplesRef.current = dataL.length;
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
        totalSamplesRef.current = 0;
        pendingProtectedRef.current = [];
        backfillTokenRef.current += 1; // 진행 중이던 백필 결과를 무효화 — 새 세션은 0부터 라이브로만 채운다
        readyRef.current = true;
        setVersion((v) => v + 1);
        return;
      }
      if (ev.type !== "protected") return;

      if (!readyRef.current) { pendingProtectedRef.current.push(ev); return; }

      const durationSec = durationRef.current;
      if (durationSec <= 0) return;
      applyProtectedEvent(ev, durationSec);
    });

    return () => {
      off();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [subscribeCaptureStream, applyProtectedEvent]);

  const originalSeriesL = useMemo(
    () => (original ? envelopeToSeries(original.envL, original.durationSec) : []),
    [original],
  );
  const originalSeriesR = useMemo(
    () => (original ? envelopeToSeries(original.envR, original.durationSec) : []),
    [original],
  );

  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    datazoom: (params: unknown) => {
      const zoom = extractZoomState(params);
      if (zoom) zoomRef.current = zoom;
      const next = shouldShowFrameSymbols(pointCountRef.current, zoomRef.current);
      setShowSymbols((prev) => (prev === next ? prev : next));
    },
  };

  const option = useMemo(() => {
    if (!original) return null;
    void version;

    const showL = channelMode !== "R";
    const showR = channelMode !== "L";

    const [protectedEnvL, protectedEnvR] = protectedEnvRefs.current;
    const protectedSeriesL = showL ? envelopeToSeries(protectedEnvL, original.durationSec) : [];
    const protectedSeriesR = showR ? envelopeToSeries(protectedEnvR, original.durationSec) : [];

    let peak = Y_MIN_SPAN;
    if (showL) peak = Math.max(peak, original.envL.peak());
    if (showR) peak = Math.max(peak, original.envR.peak());
    peak *= Y_SCALE_PADDING;

    pointCountRef.current = showL ? originalSeriesL.length : originalSeriesR.length;

    const timeDecimals = timeDecimalsForInterval(original.durationSec / BUCKETS);
    const axisDomain = { dataMin: 0, dataMax: original.durationSec, dataDecimals: timeDecimals };

    // Input(원본 참고선)은 옅은 색 + 점선으로 배경에 깔고, Protected(보호 감쇠 후 신호)는
    // 진한 색 + 굵은 실선으로 항상 그 위에(z로 고정, 배열 순서와 무관하게) 그린다 — 그래야
    // Both 모드에서 반대 채널의 Input 라인이 Protected 라인을 가리는 일이 없다.
    const series = [
      ...(showL ? [
        { name: channelMode === "Both" ? "Input L" : "Input", type: "line" as const, z: 1, symbol: showSymbols ? "circle" : "none", showSymbol: showSymbols, symbolSize: 4, lineStyle: { width: 1, color: COLOR_INPUT_L, type: "dashed" as const, opacity: 0.85 }, data: originalSeriesL },
      ] : []),
      ...(showR ? [
        { name: channelMode === "Both" ? "Input R" : "Input", type: "line" as const, z: 1, symbol: showSymbols ? "circle" : "none", showSymbol: showSymbols, symbolSize: 4, lineStyle: { width: 1, color: COLOR_INPUT_R, type: "dashed" as const, opacity: 0.85 }, data: originalSeriesR },
      ] : []),
      ...(showL ? [
        { name: channelMode === "Both" ? "Protected L" : "Protected", type: "line" as const, z: 2, symbol: showSymbols ? "circle" : "none", showSymbol: showSymbols, symbolSize: 4, lineStyle: { width: 1.8, color: COLOR_PROTECTED_L }, data: protectedSeriesL },
      ] : []),
      ...(showR ? [
        { name: channelMode === "Both" ? "Protected R" : "Protected", type: "line" as const, z: 2, symbol: showSymbols ? "circle" : "none", showSymbol: showSymbols, symbolSize: 4, lineStyle: { width: 1.8, color: COLOR_PROTECTED_R }, data: protectedSeriesR },
      ] : []),
    ];

    // 범례는 채널별로 짝지어 보이는 게 읽기 편해서 z-순서(위 배열)와 별개로 [Input L, Protected L,
    // Input R, Protected R] 순으로 재배열한다 — 실제 렌더 순서는 각 series의 z 값이 결정한다.
    const legendOrder = ["Input L", "Protected L", "Input R", "Protected R", "Input", "Protected"];
    const legendNames = series.map((s) => s.name).sort((a, b) => legendOrder.indexOf(a) - legendOrder.indexOf(b));

    return {
      animation: false,
      tooltip: buildValueTooltip({ unit: "", decimals: 3, timeDecimals: 3 }),
      legend: {
        data: legendNames,
        textStyle: { color: "#64748b", fontSize: 11 },
        top: 0,
      },
      grid: { left: 56, right: 16, top: 32, bottom: 44 },
      dataZoom: buildDataZoom(zoomRef, { filler: "rgba(37,99,235,0.12)", handle: COLOR_PROTECTED_L }, axisDomain),
      xAxis: {
        type: "value" as const,
        min: 0,
        max: original.durationSec,
        axisLabel: { formatter: buildDynamicTimeFormatter(zoomRef, axisDomain), color: "#94A3B8", fontSize: 10 },
        axisLine: { lineStyle: { color: "#E2E8F0" } },
        splitLine: { lineStyle: { color: "#F1F5F9" } },
      },
      yAxis: {
        type: "value" as const,
        min: -peak,
        max: peak,
        axisLabel: { formatter: (v: number) => v.toFixed(2), color: "#94A3B8", fontSize: 10 },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: "#F1F5F9" } },
      },
      series,
    };
  }, [original, originalSeriesL, originalSeriesR, version, showSymbols, channelMode]);

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

      <div className="chart-body flex-1 p-2 min-h-[160px]">
        {option && !placeholder ? (
          <ReactECharts option={option} style={{ height: "100%", width: "100%" }} notMerge={false} onEvents={echartsEvents.current} />
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
