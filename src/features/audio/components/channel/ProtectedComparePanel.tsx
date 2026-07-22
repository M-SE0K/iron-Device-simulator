"use client";

// 보호 감쇠 전/후 파형 비교 — 음원 전체 길이를 고정 시간축으로 깔고, 원본 파형은 로드 시점에
// 한 번만 그린 뒤 보호(감쇠 후) 파형만 재생 진행에 따라 왼쪽부터 채워 나간다.
//
// 핵심 자료구조는 "픽셀 버킷 포락선"이다 — 샘플을 쌓아두지 않고 도착 즉시 해당 시간 버킷의
// min/max에 접어 넣는다. 그래서 메모리와 렌더 비용이 음원 길이와 무관하게 상수다(BUCKETS에만
// 비례). 롤링 윈도우가 필요 없는 이유이자, DashboardClient의 출력 큐(USE_QUEUE) 방식을 그대로
// 가져올 수 없는 이유이기도 하다 — 그쪽은 프레임 배열을 append 복사(setStreamingFrames(prev =>
// [...prev, ...]))하는데, 초당 48,000 샘플에는 그 방식이 성립하지 않는다.
//
// 두 계열은 같은 분석 프레임에서 나오므로 샘플 단위로 정렬돼 있다(protocol/analysis.ts의
// 바이너리 메시지가 input/processed를 쌍으로 실어 보낸다). 원본 파형만은 예외로 음원 파일을
// 직접 디코드해서 얻는다 — 재생 전에 전체 구간이 미리 보여야 하기 때문이다.
//
// ⚠️ 현재 엔진은 참조 스텁(electron/native/wasm-engine/ff_prot.c)이라 감쇠 커브가 임의값이다.
//    파이프라인 검증용이며 실제 보호 성능이 아니다 — 배지로 화면에도 명시한다.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import ReactECharts from "@/shared/components/ReactECharts";
import { cn } from "@/shared/lib/utils";
import { INT16_SCALE, CHANNELS } from "@/features/audio/lib/engine/core";
import {
  buildValueTooltip, buildDataZoom, buildDynamicTimeFormatter,
  timeDecimalsForInterval, shouldShowFrameSymbols, type ZoomStateRef,
} from "@/features/audio/lib/render/chart-option";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/useCaptureSession";

// 전체 구간을 나눌 시간 버킷 수. 버킷마다 min/max 두 점을 내보내므로 계열당 표시 점은 최대
// 2×BUCKETS = 2000개 — 일반적인 차트 폭(1000~1600px)보다 촘촘해서 포락선 손실이 없으면서도
// ECharts가 매 틱 다시 그려도 부담 없는 수준이다.
const BUCKETS = 1000;
// 화면 갱신 간격(ms). 프레임은 100 fps로 들어오지만 파형 포락선은 20 fps면 충분히 매끄럽다 —
// rAF(60 fps)마다 계열 배열을 다시 만들면 그 할당이 실제 병목이 된다.
const FLUSH_INTERVAL_MS = 50;
// Y축 여유(대칭 피크의 배수) — ChannelWaveformCanvas의 Y_SCALE_PADDING과 같은 취지.
const Y_SCALE_PADDING = 1.1;
const Y_MIN_SPAN = 0.05;

const COLOR_INPUT     = "#94a3b8"; // 감쇠 전(원본) — 흐리게, 배경 역할
const COLOR_PROTECTED = "#38bdf8"; // 감쇠 후 — 강조

/**
 * 시간 버킷별 min/max 포락선. 샘플을 저장하지 않고 버킷에 접어 넣기만 하므로 add()는 O(1)이고
 * 전체 메모리는 음원 길이와 무관하게 BUCKETS에 고정된다.
 */
class BucketEnvelope {
  readonly min: Float32Array;
  readonly max: Float32Array;
  /** 아직 값이 들어오지 않은 버킷을 0으로 그리지 않기 위한 플래그. */
  readonly seen: Uint8Array;
  /** 값이 들어온 가장 큰 버킷 인덱스 — 보호 파형이 "어디까지 채워졌는지"에 해당한다. */
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

  /** 채워진 구간의 최대 절대 진폭. */
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

/**
 * 포락선을 ECharts 계열 데이터로 편다. 버킷마다 min·max 두 점을 내보내되 x를 버킷 안에서
 * 살짝 벌려 시간 순서를 유지한다 — 같은 x에 두 점을 놓으면 선이 뒤로 꺾인다.
 */
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

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // revoke를 동기로 하면 일부 브라우저에서 다운로드가 취소된다 — 다음 tick으로 미룬다.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ProtectedComparePanelImpl({
  subscribeCaptureStream,
  getProtectedBlob,
  getRecordedBlob,
  sourceFile,
  channel = 0,
  bare = false,
}: {
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
  getProtectedBlob: () => Blob | null;
  getRecordedBlob: () => Blob | null;
  /**
   * 재생 대상 음원 파일. 재생 전에 원본 전체 파형을 깔기 위해 직접 디코드한다 — 캡처 스트림의
   * input은 재생이 진행된 만큼만 도착하므로 전체 구간의 소스가 될 수 없다.
   */
  sourceFile?: File | null;
  /** 비교할 채널 — 0=V, 1=I (원본 파일에서는 0=L, 1=R로 대응) */
  channel?: number;
  /**
   * true면 자체 카드 테두리/그림자/헤더 구분선을 생략한다 — ChannelStackView처럼 이미 자체
   * 카드 박스+헤더로 감싸는 컨테이너 안에 넣을 때 이중 테두리를 피하기 위함. 대시보드 단독
   * 배치(기본값 false)에서는 다른 차트 카드와 같은 톤을 내도록 카드 테두리를 그대로 그린다.
   */
  bare?: boolean;
}) {
  // 원본 포락선 + 전체 길이. 파일 디코드로 한 번 만들어지고 이후 변하지 않는다.
  const [original, setOriginal] = useState<{ env: BucketEnvelope; durationSec: number } | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);

  // 보호 포락선은 스트림으로 채워지므로 ref에 두고, 화면 갱신만 version으로 트리거한다 —
  // 프레임마다 setState하면 리렌더가 렌더링을 압도한다.
  const protectedEnvRef = useRef<BucketEnvelope>(new BucketEnvelope(BUCKETS));
  const sampleRateRef   = useRef(0);
  // 캡처 스트림에서 누적된 샘플 수 — 시간축 위치(=버킷 인덱스)를 구하는 데 쓴다.
  const totalSamplesRef = useRef(0);
  const [version, setVersion] = useState(0);

  const rafRef       = useRef<number | null>(null);
  const dirtyRef     = useRef(false);
  const lastFlushRef = useRef(0);

  // 전체 길이는 원본 디코드 결과에서 얻는다 — 콜백이 매번 최신값을 읽도록 ref로 미러링한다.
  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = original?.durationSec ?? 0; }, [original]);

  // ── 줌 상태 보존 — Temperature/ExcursionChart와 동일한 규약(ref로 관리해 렌더 유발 없이
  // option에 반영). 확대해서 포락선 점이 충분히 벌어졌을 때만 점(symbol)을 표시한다.
  const zoomRef: ZoomStateRef = useRef({ start: 0, end: 100 });
  const [showSymbols, setShowSymbols] = useState(false);
  const pointCountRef = useRef(0);

  // ── 원본 파형: 파일을 한 번 디코드해 버킷에 접는다 ────────────────────────
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
        // 원본이 모노면 채널 0으로 떨어진다(V/I 인덱스를 그대로 쓰되 범위만 맞춘다).
        const data = buf.getChannelData(Math.min(channel, buf.numberOfChannels - 1));
        const env = new BucketEnvelope(BUCKETS);
        // 전체 샘플 1회 순회 — 긴 음원이면 수십 ms 블로킹되지만 파일당 한 번뿐이다.
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

  // 새 파일이면 보호 포락선도 리셋한다(시간축 자체가 바뀐다) — 줌/점 표시 상태도 함께 초기화.
  useEffect(() => {
    protectedEnvRef.current.clear();
    totalSamplesRef.current = 0;
    zoomRef.current = { start: 0, end: 100 };
    setShowSymbols(false);
    setVersion((v) => v + 1);
  }, [sourceFile]);

  const flush = useCallback(() => {
    rafRef.current = null;
    if (!dirtyRef.current) return;

    // 100 fps 유입을 FLUSH_INTERVAL_MS 간격으로 눌러 준다 — 아직 이르면 다음 프레임에 재시도.
    const now = performance.now();
    if (now - lastFlushRef.current < FLUSH_INTERVAL_MS) {
      rafRef.current = requestAnimationFrame(flush);
      return;
    }
    lastFlushRef.current = now;
    dirtyRef.current = false;
    setVersion((v) => v + 1);
  }, []);

  // ── 보호 파형: 캡처 스트림을 버킷에 누적 ──────────────────────────────────
  useEffect(() => {
    const off = subscribeCaptureStream((ev: CaptureStreamEvent) => {
      if (ev.type === "reset") {
        protectedEnvRef.current.clear();
        totalSamplesRef.current = 0;
        setVersion((v) => v + 1);
        return;
      }
      if (ev.type !== "protected") return;

      const durationSec = durationRef.current;
      // 전체 길이를 모르면 버킷 인덱스를 정할 수 없다 — 원본 디코드가 끝날 때까지 버린다.
      if (durationSec <= 0) return;

      sampleRateRef.current = ev.sampleRate;
      const env = protectedEnvRef.current;
      const base = totalSamplesRef.current;
      // 버킷 인덱스는 샘플 수가 아니라 시간으로 잡는다 — 엔진 샘플레이트와 파일 샘플레이트가
      // 달라도 같은 시간축에 정렬된다.
      const perBucketSec = durationSec / BUCKETS;

      for (let i = channel, s = 0; i < ev.processed.length; i += CHANNELS, s++) {
        const t = (base + s) / ev.sampleRate;
        env.add(Math.floor(t / perBucketSec), ev.processed[i] / INT16_SCALE);
      }
      totalSamplesRef.current = base + ev.processed.length / CHANNELS;

      dirtyRef.current = true;
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
    });

    return () => {
      off();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [subscribeCaptureStream, channel, flush]);

  // 원본 계열은 디코드 후 변하지 않으므로 한 번만 만든다 — 매 틱 다시 만들 이유가 없다.
  const originalSeries = useMemo(
    () => (original ? envelopeToSeries(original.env, original.durationSec) : []),
    [original],
  );

  // ── ECharts 이벤트 — Temperature/ExcursionChart와 동일한 datazoom 규약(줌 상태를 ref에
  // 저장 + 확대 정도에 따라 포락선 점 표시 여부 갱신).
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
    void version; // 보호 포락선(ref)이 갱신될 때마다 계열을 다시 만들기 위한 의존성

    const protectedSeries = envelopeToSeries(protectedEnvRef.current, original.durationSec);
    const peak = Math.max(original.env.peak(), Y_MIN_SPAN) * Y_SCALE_PADDING;
    pointCountRef.current = originalSeries.length;

    // 버킷 간격(초) 기준으로 필요한 시간축 소수 자릿수를 정한다 — Temperature/ExcursionChart의
    // resolveTimeDecimals(프레임 간격 기준)와 같은 규약을 버킷 폭에 맞춰 적용.
    const timeDecimals = timeDecimalsForInterval(original.durationSec / BUCKETS);
    const axisDomain = { dataMin: 0, dataMax: original.durationSec, dataDecimals: timeDecimals };

    // buildBaseChartOption()은 AnalysisFrame 윈도우 전용이라 여기엔 맞지 않는다 — 파형 2계열만
    // 그리는 최소 옵션을 직접 구성한다. 툴팁/dataZoom/동적 시간 포매터만 공통 규약을 재사용한다.
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
        // 전체 길이로 고정 — 재생이 진행돼도 축이 움직이지 않는다.
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

  // 지금까지 채워진 구간의 피크 비율 = 대략적인 감쇠량. 프레임별 정확한 게인이 아니라 눈대중.
  const attenuationDb = useMemo(() => {
    void version;
    if (!original) return null;
    const env = protectedEnvRef.current;
    if (env.filledUpTo < 0) return null;

    // 같은 구간끼리 비교해야 한다 — 원본은 전체가 차 있으므로 보호가 채운 데까지만 자른다.
    let pIn = 0;
    for (let b = 0; b <= env.filledUpTo; b++) {
      if (original.env.seen[b] === 0) continue;
      const a = Math.max(Math.abs(original.env.min[b]), Math.abs(original.env.max[b]));
      if (a > pIn) pIn = a;
    }
    const pOut = env.peak();
    if (pIn <= 0 || pOut <= 0) return null;
    return 20 * Math.log10(pOut / pIn);
  }, [original, version]);

  const handleDownload = useCallback((kind: "protected" | "original") => {
    const blob = kind === "protected" ? getProtectedBlob() : getRecordedBlob();
    if (!blob) return;
    downloadBlob(blob, kind === "protected" ? "protected.wav" : "original.wav");
  }, [getProtectedBlob, getRecordedBlob]);

  const placeholder = decodeError
    ?? (decoding ? "원본 파형을 준비하는 중입니다…" : null)
    ?? (!sourceFile ? "음원을 선택하면 원본 파형이 표시됩니다." : null);

  return (
    <div id="protected-compare-panel" className={cn("flex flex-col h-full", !bare && "card")}>
      <div className={bare ? "flex items-center justify-between gap-2 px-1 pb-2 flex-wrap" : "card-header"}>
        <div className="chart-title-group flex items-center gap-2">
          <span className="card-title">보호 감쇠 비교</span>
        </div>

        <div className="flex items-center gap-2">
          {attenuationDb !== null && (
            <span className="text-xs text-iron-400">
              구간 피크 {attenuationDb.toFixed(1)} dB
            </span>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleDownload("original")}
              className="flex items-center gap-1 rounded border border-iron-200 px-2 py-1 text-xs text-iron-600 hover:bg-iron-50 hover:text-iron-800 transition-colors"
            >
              <Download size={12} /> 원본 WAV
            </button>
            <button
              type="button"
              onClick={() => handleDownload("protected")}
              className="flex items-center gap-1 rounded border border-iron-200 px-2 py-1 text-xs text-iron-600 hover:bg-iron-50 hover:text-iron-800 transition-colors"
            >
              <Download size={12} /> 보호 WAV
            </button>
          </div>
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

// 캡처 중 DashboardClient가 streamingFrames/currentTime 갱신으로 주기적으로 리렌더되지만
// 이 패널의 props(구독 함수/blob getter/sourceFile)는 세션 내내 안정적이다 — memo로 부모발
// 리렌더를 차단하고, 화면 갱신은 내부 version(20fps 스로틀)로만 일어나게 한다.
export const ProtectedComparePanel = memo(ProtectedComparePanelImpl);
