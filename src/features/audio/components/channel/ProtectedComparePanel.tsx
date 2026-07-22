"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "@/shared/components/ReactECharts";
import { cn } from "@/shared/lib/utils";
import { INT16_SCALE, CHANNELS } from "@/features/audio/lib/engine/core";
import {
  buildValueTooltip, buildDataZoom, buildDynamicTimeFormatter,
  timeDecimalsForInterval, shouldShowFrameSymbols, type ZoomStateRef,
} from "@/features/audio/lib/render/chart-option";
import { peekWavHeader, decodeWavRange } from "@/features/audio/lib/codec/wav-incremental";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/useCaptureSession";

const BUCKETS = 1000;
const FLUSH_INTERVAL_MS = 50;
const Y_SCALE_PADDING = 1.1;
const Y_MIN_SPAN = 0.05;

const COLOR_INPUT     = "#94a3b8";
const COLOR_PROTECTED = "#38bdf8";

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
  channel = 0,
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
  channel?: number;
  bare?: boolean;
}) {
  const [original, setOriginal] = useState<{ env: BucketEnvelope; durationSec: number } | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);

  const protectedEnvRef = useRef<BucketEnvelope>(new BucketEnvelope(BUCKETS));
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
        if (!cancelled) { setDecodeError("이 브라우저에서 오디오 디코드를 지원하지 않습니다."); setDecoding(false); }
        return;
      }
      const ctx = new Ctor();
      try {
        const buf = await ctx.decodeAudioData(await sourceFile.arrayBuffer());
        if (cancelled) return;
        const data = buf.getChannelData(Math.min(channel, buf.numberOfChannels - 1));
        const env = new BucketEnvelope(BUCKETS);
        const n = data.length;
        for (let i = 0; i < n; i++) {
          const b = Math.min(BUCKETS - 1, Math.floor((i * BUCKETS) / n));
          env.add(b, data[i]);
        }
        setOriginal({ env, durationSec: buf.duration });
      } catch {
        if (!cancelled) setDecodeError("음원을 디코드하지 못했습니다.");
      } finally {
        void ctx.close();
        if (!cancelled) setDecoding(false);
      }
    })();

    return () => { cancelled = true; };
  }, [sourceFile, channel]);

  useEffect(() => {
    protectedEnvRef.current.clear();
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
    const env = protectedEnvRef.current;
    const base = totalSamplesRef.current;
    const perBucketSec = durationSec / BUCKETS;

    for (let i = channel, s = 0; i < ev.processed.length; i += CHANNELS, s++) {
      const t = (base + s) / ev.sampleRate;
      env.add(Math.floor(t / perBucketSec), ev.processed[i] / INT16_SCALE);
    }
    totalSamplesRef.current = base + ev.processed.length / CHANNELS;

    dirtyRef.current = true;
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
  }, [channel, flush]);

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
              const data = await decodeWavRange(blob, header, channel, 0, header.durationSec);
              if (!cancelled && backfillTokenRef.current === token && data.length > 0) {
                const perBucketSec = original.durationSec / BUCKETS;
                const env = protectedEnvRef.current;
                for (let s = 0; s < data.length; s++) {
                  const t = s / header.sampleRate;
                  env.add(Math.floor(t / perBucketSec), data[s]);
                }
                totalSamplesRef.current = data.length;
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
  }, [original, getProtectedBlob, channel, applyProtectedEvent]);

  useEffect(() => {
    const off = subscribeCaptureStream((ev: CaptureStreamEvent) => {
      if (ev.type === "reset") {
        protectedEnvRef.current.clear();
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

  const originalSeries = useMemo(
    () => (original ? envelopeToSeries(original.env, original.durationSec) : []),
    [original],
  );

  const echartsEvents = useRef<Record<string, (...args: unknown[]) => void>>({});
  echartsEvents.current = {
    datazoom: (params: unknown) => {
      const p = params as { batch?: Array<{ start?: number; end?: number }>; start?: number; end?: number };
      const src = p.batch?.[0] ?? p;
      if (src.start !== undefined && src.end !== undefined) {
        zoomRef.current = { start: src.start, end: src.end };
      }
      const next = shouldShowFrameSymbols(pointCountRef.current, zoomRef.current);
      setShowSymbols((prev) => (prev === next ? prev : next));
    },
  };

  const option = useMemo(() => {
    if (!original) return null;
    void version;

    const protectedSeries = envelopeToSeries(protectedEnvRef.current, original.durationSec);
    const peak = Math.max(original.env.peak(), Y_MIN_SPAN) * Y_SCALE_PADDING;
    pointCountRef.current = originalSeries.length;

    const timeDecimals = timeDecimalsForInterval(original.durationSec / BUCKETS);
    const axisDomain = { dataMin: 0, dataMax: original.durationSec, dataDecimals: timeDecimals };

    return {
      animation: false,
      tooltip: buildValueTooltip({ unit: "", decimals: 3, timeDecimals: 3 }),
      legend: {
        data: ["감쇠 전", "감쇠 후"],
        textStyle: { color: "#94a3b8", fontSize: 10 },
        top: 0,
      },
      grid: { left: 56, right: 16, top: 32, bottom: 44 },
      dataZoom: buildDataZoom(zoomRef, { filler: "rgba(56,189,248,0.12)", handle: COLOR_PROTECTED }, axisDomain),
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
      series: [
        {
          name: "감쇠 전",
          type: "line" as const,
          symbol: showSymbols ? "circle" : "none",
          showSymbol: showSymbols,
          symbolSize: 4,
          lineStyle: { width: 1, color: COLOR_INPUT },
          data: originalSeries,
        },
        {
          name: "감쇠 후",
          type: "line" as const,
          symbol: showSymbols ? "circle" : "none",
          showSymbol: showSymbols,
          symbolSize: 4,
          lineStyle: { width: 1.2, color: COLOR_PROTECTED },
          data: protectedSeries,
        },
      ],
    };
  }, [original, originalSeries, version, showSymbols]);

  const placeholder = decodeError
    ?? (decoding ? "원본 파형을 준비하는 중입니다…" : null)
    ?? (!sourceFile ? "음원을 선택하면 원본 파형이 표시됩니다." : null);

  return (
    <div id="protected-compare-panel" className={cn("flex flex-col h-full", !bare && "card")}>
      <div className={bare ? "flex items-center justify-between gap-2 px-1 pb-2 flex-wrap" : "card-header"}>
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">보호 알고리즘 적용</span>
        </div>
      </div>

      <div className="chart-body flex-1 p-2 min-h-[160px]">
        {option && !placeholder ? (
          <ReactECharts option={option} style={{ height: "100%", width: "100%" }} notMerge={false} onEvents={echartsEvents.current} />
        ) : (
          <div className="chart-empty-state h-full flex items-center justify-center text-xs text-iron-300">
            {placeholder ?? "분석이 시작되면 감쇠 후 파형이 여기에 겹쳐 표시됩니다."}
          </div>
        )}
      </div>
    </div>
  );
}

export const ProtectedComparePanel = memo(ProtectedComparePanelImpl);
