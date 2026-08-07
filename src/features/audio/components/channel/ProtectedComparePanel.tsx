"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotOptions } from "@/shared/components/UPlotChart";
import { cn } from "@/shared/lib/utils";
import { INT16_SCALE, CHANNELS } from "@/features/audio/lib/engine/core";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import { buildTimeAxis, buildValueAxis } from "@/features/audio/lib/render/uplot-option";
import { staticSeriesLayerPlugin, liveEnvelopeOverlayPlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import {
  BucketEnvelope,
  buildBucketXs,
  emptyEnvelopeColumn,
  fillEnvelopeColumn,
  type EnvelopeColumn,
} from "@/features/audio/lib/render/envelope";
import { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import { peekWavHeader, decodeWavRange } from "@/features/audio/lib/codec/wav-incremental";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";

const Y_SCALE_PADDING = 1.1;
const Y_MIN_SPAN = 0.05;

/**
 * Protected 트레이스는 독립된 growing store로 그려진다(live-envelope-overlay.ts) — 초기
 * 버킷 폭을 1ms로 잡아, 재생 초반부는 실제로 ms 단위 해상도로 확인할 수 있다. 50초
 * (= MAX_WAVE_BUCKETS × 1ms) 지점부터는 ChannelWaveStore의 압축 로직대로 점점 넓어진다
 * (세션이 길어져도 버킷 개수 상한은 유지).
 */
const PROTECTED_INITIAL_BUCKET_SEC = 0.001;

/**
 * Input(원본 PCM)은 업로드 시점에 전체 길이가 이미 확정돼 있다 — Protected처럼 "얼마나
 * 길어질지 모르는 스트림"이 아니므로, 라이브용 점진적 압축(ChannelWaveStore) 대신 파일 길이
 * 하나로 버킷 수를 한 번에 계산해 정적으로 채운다(BucketEnvelope). 목표는 1ms/버킷이고,
 * 그러면 버킷 수가 너무 커지는 아주 긴 파일에서만 MAX_INPUT_BUCKETS로 상한을 건다.
 */
const INPUT_TARGET_BUCKET_SEC = 0.001;
const MAX_INPUT_BUCKETS = 50000;

function computeInputBuckets(durationSec: number): number {
  if (!(durationSec > 0)) return 1;
  return Math.min(MAX_INPUT_BUCKETS, Math.max(1, Math.ceil(durationSec / INPUT_TARGET_BUCKET_SEC)));
}

type ChannelMode = "L" | "R" | "Both";

/**
 * Input(원본)은 **무채색**, Protected(보호 후)는 유채색이다. 이 패널의 관심사는 "원본 대비
 * 무엇이 얼마나 깎였나"라, 두 쌍을 같은 채도로 그리면 겹친 구간에서 어느 쪽이 결과인지
 * 한눈에 안 들어온다. 원본은 배경 기준선으로 물러나고 보호 결과만 색으로 떠오르게 한다.
 *
 * L/R 구분은 채도가 아니라 **명도 두 단계**로 준다(iron-600 / iron-400 = 프로젝트 회색 팔레트).
 */
export const COLOR_INPUT_L     = "#475569";
export const COLOR_PROTECTED_L = "#2563eb";
export const COLOR_INPUT_R     = "#94A3B8";
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

  // Protected(L/R)는 Input과 달리 파일 길이 기준 고정 1000버킷에 묶이지 않는다 — 각자
  // 독립된 ChannelWaveStore(1ms 초기 버킷, 세션이 길어지면 스스로 압축)로 자란다.
  const protectedStoresRef = useRef<[ChannelWaveStore, ChannelWaveStore]>([
    new ChannelWaveStore(PROTECTED_INITIAL_BUCKET_SEC),
    new ChannelWaveStore(PROTECTED_INITIAL_BUCKET_SEC),
  ]);
  const sampleRateRef = useRef(0);

  // Input 컬럼만 담는다 — original이 바뀔 때만(파일 선택 시) 다시 만들어지고, 그 뒤로는
  // 라이브 프레임이 아무리 와도 재생성되지 않는다(라이브 오버레이는 여기와 무관하게 그려짐).
  const colsRef = useRef<{
    owner: object;
    xs: Float64Array;
    inputL: EnvelopeColumn;
    inputR: EnvelopeColumn;
    protectedPlaceholder: EnvelopeColumn;
  } | null>(null);

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
        const buckets = computeInputBuckets(buf.duration);
        const envL = new BucketEnvelope(buckets);
        const envR = new BucketEnvelope(buckets);
        const n = dataL.length;
        for (let i = 0; i < n; i++) {
          const b = Math.min(buckets - 1, Math.floor((i * buckets) / n));
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
    protectedStoresRef.current[0].reset();
    protectedStoresRef.current[1].reset();
    colsRef.current = null;
    readyRef.current = false;
    pendingProtectedRef.current = [];
    backfillTokenRef.current += 1;
  }, [sourceFile]);

  const applyProtectedEvent = useCallback((ev: ProtectedEvent) => {
    sampleRateRef.current = ev.sampleRate;
    const [storeL, storeR] = protectedStoresRef.current;
    const samplesPerFrame = ev.processed.length / CHANNELS;
    const startSec = (ev.frameIndex * samplesPerFrame) / ev.sampleRate;

    const l = new Float32Array(samplesPerFrame);
    const r = new Float32Array(samplesPerFrame);
    for (let s = 0; s < samplesPerFrame; s++) {
      l[s] = ev.processed[s * CHANNELS] / INT16_SCALE;
      r[s] = ev.processed[s * CHANNELS + 1] / INT16_SCALE;
    }
    storeL.addBlock(l, startSec, ev.sampleRate);
    storeR.addBlock(r, startSec, ev.sampleRate);
    storeL.flush();
    storeR.flush();
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
                const [storeL, storeR] = protectedStoresRef.current;
                storeL.addBlock(dataL, 0, header.sampleRate);
                storeR.addBlock(dataR, 0, header.sampleRate);
                storeL.flush();
                storeR.flush();
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
      for (const ev of queued) applyProtectedEvent(ev);
    })();

    return () => { cancelled = true; };
  }, [original, getProtectedBlob, applyProtectedEvent]);

  useEffect(() => {
    const off = subscribeCaptureStream((ev: CaptureStreamEvent) => {
      if (ev.type === "reset") {
        protectedStoresRef.current[0].reset();
        protectedStoresRef.current[1].reset();
        colsRef.current = null;
        pendingProtectedRef.current = [];
        backfillTokenRef.current += 1;
        readyRef.current = true;
        return;
      }
      if (ev.type !== "protected") return;

      if (!readyRef.current) {
        pendingProtectedRef.current.push(ev);
        return;
      }

      applyProtectedEvent(ev);
    });

    return off;
  }, [subscribeCaptureStream, applyProtectedEvent]);

  const showL = channelMode !== "R";
  const showR = channelMode !== "L";

  const chartData = useMemo(() => {
    if (!original) return null;

    let cols = colsRef.current;
    if (!cols || cols.owner !== original) {
      // original.envL/envR는 이미 computeInputBuckets(durationSec) 크기로 만들어져 있다 —
      // 여기서도 같은 함수로 다시 계산해(순수함수라 같은 durationSec엔 항상 같은 값) xs 길이를 맞춘다.
      const buckets = computeInputBuckets(original.durationSec);
      cols = {
        owner: original,
        xs: buildBucketXs(buckets, original.durationSec),
        inputL: fillEnvelopeColumn(original.envL),
        inputR: fillEnvelopeColumn(original.envR),
        // Protected 컬럼은 실데이터를 담지 않는다 — series의 paths:()=>null과 짝지어
        // 그리기를 liveEnvelopeOverlayPlugin에 완전히 위임한다(아래 options). uPlot의
        // AlignedData 계약상 길이만 xs와 맞으면 되므로 재사용 가능한 상수 하나로 충분하다.
        protectedPlaceholder: emptyEnvelopeColumn(buckets),
      };
      colsRef.current = cols;
    }

    return [
      cols.xs,
      cols.inputL,
      cols.inputR,
      cols.protectedPlaceholder,
      cols.protectedPlaceholder,
    ] as unknown as uPlot.AlignedData;
  }, [original]);

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
    const inputSeries = (label: string, color: string): uPlot.Series => ({
      label, stroke: `${color}D9`, width: 1, spanGaps: true,
      paths: () => null,
      points: { show: false },
    });
    // Protected도 uPlot의 기본 경로 빌드를 끈다 — 실제 스트로크는 liveEnvelopeOverlayPlugin이
    // u.series[idx]의 show/stroke/width/points만 빌려 캔버스에 직접 그린다(u.data[idx]는 안 읽음).
    // points는 Temperature/Excursion과 같은 규약이다 — 지름(CSS px)만 주면 오버레이가 uPlot과
    // 동일한 기준(점 간격이 촘촘해지면 생략)으로 알아서 켜고 끈다.
    const protectedSeries = (label: string, color: string): uPlot.Series => ({
      label, stroke: color, width: 1.8, spanGaps: true,
      paths: () => null,
      points: { size: 4, fill: color },
    });
    const [storeL, storeR] = protectedStoresRef.current;
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
        buildTimeAxis(),
        buildValueAxis({ size: 56, formatter: (v: number) => v.toFixed(2) }),
      ],
      plugins: [
        staticSeriesLayerPlugin([1, 2]),
        liveEnvelopeOverlayPlugin([
          { store: storeL, seriesIdx: 3 },
          { store: storeR, seriesIdx: 4 },
        ]),
        zoomPlugin({ getFullXRange: () => [0, original.durationSec] }),
        tooltipPlugin({
          unit: "", decimals: 3,
          virtualSeries: [
            { label: "Protected L", seriesIdx: 3, resolve: (t) => storeL.valueAt(t) },
            { label: "Protected R", seriesIdx: 4, resolve: (t) => storeR.valueAt(t) },
          ],
        }),
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
              yZoom
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
