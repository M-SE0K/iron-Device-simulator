"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import UPlotChart, { type UPlotOptions } from "@/shared/components/UPlotChart";
import { cn } from "@/shared/lib/utils";
import { CHANNELS } from "@/features/audio/lib/engine/core";
import { copyChannelFloat32, readChannelFloat32 } from "@/features/audio/lib/pcm";
import type { DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";
import SegmentedControl from "@/shared/components/ui/SegmentedControl";
import { buildTimeAxis, buildValueAxis } from "@/features/audio/lib/render/uplot-option";
import { symmetricYRange } from "@/features/audio/lib/render/chart-window";
import { envelopeOverlayPlugin, tooltipPlugin, zoomPlugin } from "@/features/audio/lib/render/uplot-plugins";
import { ChannelWaveStore, MAX_WAVE_BUCKETS } from "@/features/audio/lib/render/wave-store";
import { peekWavHeader, decodeWavRange } from "@/features/audio/lib/codec/wav-incremental";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/types";

const Y_MIN_SPAN = 0.05;

/**
 * 원본 PCM을 엔벨로프로 소화할 때의 조각 크기(프레임). 전체 길이의 채널 배열을 만드는 대신
 * 이 크기의 scratch 두 개(채널당 512 KB)로 잘라 addBlock한다 — 5분 파일 기준 채널당 57 MB의
 * 임시 할당이 사라진다. addBlock은 절대 시각 버킷이라 조각 순서/재사용에 안전하다.
 */
const EXTRACT_CHUNK_FRAMES = 131072;

/**
 * 네 트레이스(Input L/R · Protected L/R)가 **모두 같은 종류의 스토어**(ChannelWaveStore)에
 * 담기고, 그리기는 전부 envelopeOverlayPlugin이 뷰포트 단위로 읽어 처리한다. uPlot의 u.data에는
 * 실데이터가 한 점도 실리지 않는다.
 *
 * 예전에는 Input만 다른 경로였다 — 전체 길이가 이미 확정돼 있으니 파일 전체를 정적 엔벨로프로
 * 만들어 u.data에 통째로 싣고(1 ms 버킷 × min/max = 최대 10만 점), 오프스크린 캔버스에 캐시하는
 * 별도 플러그인이 그렸다. 캐시 키에 x/y 스케일이 들어가는 구조라 **줌·팬 한 스텝마다 캐시가
 * 깨져** 10만 점짜리 경로를 L/R 두 번 다시 만들었고, 그게 이 패널에서만 줌이 눈에 띄게 무겁던
 * 원인이었다. 지금은 보이는 구간만 화면 폭만큼 읽으므로 줌 비용이 세션 길이를 타지 않는다.
 *
 * 격자를 공유시키는 방식도 이 통합으로 단순해졌다. Protected는 "얼마나 길어질지 모르는 스트림"
 * 이지만 시작 전에 이미 원본 디코딩이 끝나 전체 길이를 알고 있으므로, 두 쌍 모두 같은
 * bucketSecFor(durationSec)를 setInitialBucketSec으로 심어 압축(compact)이 아예 일어나지 않는
 * 동일 격자 위에서 자란다 — 겹쳐 볼 때 같은 시각의 두 값이 정확히 같은 x에 놓인다.
 */
const TARGET_BUCKET_SEC = 0.001;
/**
 * 스토어 상한에 **닿지 않게** 1% 여유를 둔다. 딱 맞추면 addBlock의 ensureCapacity가 압축을 걸어
 * 버킷 폭이 2배가 되는데, Input(전체를 한 번에 넣는다)은 그 압축이 즉시 일어나고 Protected
 * (점진적으로 자란다)는 세션 끝에서야 일어나 두 격자가 중간 내내 어긋난다.
 *
 * 한 칸이 아니라 1%인 것은 Protected가 원본보다 **살짝 길어질 수 있기** 때문이다 — 마지막
 * 프레임이 통째로 들어오므로 끝이 최대 한 프레임(수 ms)만큼 duration을 넘어선다. 이 여유가
 * 곧 그 초과분의 허용치이고(전체 길이의 1% ≈ 5분 파일에서 3초), 버킷 폭은 1%만 넓어진다.
 */
const MAX_BUCKETS = Math.floor(MAX_WAVE_BUCKETS * 0.99);

/** 이 길이를 목표 해상도(1 ms/버킷)로 담되, 너무 긴 파일에서만 버킷 수 상한에 걸리게 하는 폭. */
function bucketSecFor(durationSec: number): number {
  if (!(durationSec > 0)) return TARGET_BUCKET_SEC;
  const buckets = Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(durationSec / TARGET_BUCKET_SEC)));
  return durationSec / buckets;
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

interface PanelStores {
  inputL: ChannelWaveStore;
  inputR: ChannelWaveStore;
  protectedL: ChannelWaveStore;
  protectedR: ChannelWaveStore;
}

/** 디코딩이 끝나 차트를 그릴 수 있게 된 원본의 요약 — 스토어 자체는 ref가 들고 있다. */
interface InputMeta {
  durationSec: number;
  peakL: number;
  peakR: number;
}

function ProtectedComparePanelImpl({
  subscribeCaptureStream,
  sourceFile,
  getDecodedPlayback,
  decodeReady = false,
  getProtectedBlob,
  bare = false,
  hiddenSeries,
}: {
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
  sourceFile?: File | null;
  /**
   * 재생 경로(DuplexFilePlayer)가 이미 디코딩해 둔 원본 PCM getter — 패널이 같은 파일을
   * decodeAudioData로 한 번 더 통째로 디코딩하지 않고 이걸로 Input 엔벨로프를 만든다.
   */
  getDecodedPlayback?: () => DecodedPlayback | null;
  /** 재생 경로의 디코딩 완료 여부 — true가 되는 시점에 위 getter가 채워져 있다. */
  decodeReady?: boolean;
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
  const [channelMode, setChannelMode] = useState<ChannelMode>("Both");
  const [input, setInput] = useState<InputMeta | null>(null);

  // 스토어 하나가 400 KB 남짓의 typed array를 들고 있으므로 반드시 **지연 생성**한다 —
  // useRef(new ...())로 쓰면 렌더마다 네 개를 새로 만들어 버리고 즉시 버린다.
  const storesRef = useRef<PanelStores | null>(null);
  if (storesRef.current === null) {
    storesRef.current = {
      inputL: new ChannelWaveStore(),
      inputR: new ChannelWaveStore(),
      protectedL: new ChannelWaveStore(),
      protectedR: new ChannelWaveStore(),
    };
  }
  const stores = storesRef.current;

  const sampleRateRef = useRef(0);

  // 패널이 세션 도중 마운트됐을 때(상세 뷰에서 뒤늦게 "보호 감쇠" 항목을 선택하는 경우)
  // 백필이 끝나기 전까지 들어오는 라이브 프레임을 잃지 않도록 대기시킨다.
  type ProtectedEvent = Extract<CaptureStreamEvent, { type: "protected" }>;
  const pendingProtectedRef = useRef<ProtectedEvent[]>([]);
  const readyRef = useRef(false);
  // 백필 진행 중 세션이 리셋되면(재생 재시작 등) 오래된 백필 결과가 새 세션 데이터와
  // 섞이지 않도록 토큰으로 무효화한다.
  const backfillTokenRef = useRef(0);

  // Input 엔벨로프 — 재생 경로가 디코딩해 둔 PCM(인터리브 스테레오, 캘리브레이션 샘플레이트로
  // 리샘플됨)을 그대로 소화한다. 예전엔 여기서 같은 파일을 decodeAudioData로 한 번 더 통째로
  // 디코딩했다 — 파일 선택마다 풀 디코드가 2회 돌던 것을 재생용 1회로 합쳤다. 피크/엔벨로프가
  // 원본이 아니라 리샘플된 PCM 기준이 되지만, 리샘플이 바꾸는 건 시간 격자뿐이라 1 ms 버킷
  // 엔벨로프에서는 차이가 보이지 않는다. 디코딩 실패는 재생 경로가 에러 팝업으로 알린다.
  //
  // 원본은 전량이 이미 확정돼 있으므로 한 번에 밀어 넣고 그 뒤로는 갱신되지 않는다 —
  // 스토어가 dirty해지지 않으니 오버레이의 rAF 루프도 이쪽 때문에 깨어나지 않는다.
  useEffect(() => {
    const decoded = decodeReady ? getDecodedPlayback?.() ?? null : null;
    if (!decoded) {
      setInput(null);
      return;
    }

    const bucketSec = bucketSecFor(decoded.duration);
    const { inputL, inputR } = stores;
    inputL.reset();
    inputR.reset();
    inputL.setInitialBucketSec(bucketSec);
    inputR.setInitialBucketSec(bucketSec);

    const totalFrames = Math.floor(decoded.pcm.length / CHANNELS);
    const chunkFrames = Math.max(1, Math.min(totalFrames, EXTRACT_CHUNK_FRAMES));
    const scratchL = new Float32Array(chunkFrames);
    const scratchR = new Float32Array(chunkFrames);
    for (let start = 0; start < totalFrames; start += chunkFrames) {
      const n = copyChannelFloat32(decoded.pcm, CHANNELS, 0, start, scratchL);
      copyChannelFloat32(decoded.pcm, CHANNELS, 1, start, scratchR);
      const startSec = start / decoded.rate;
      inputL.addBlock(n === chunkFrames ? scratchL : scratchL.subarray(0, n), startSec, decoded.rate);
      inputR.addBlock(n === chunkFrames ? scratchR : scratchR.subarray(0, n), startSec, decoded.rate);
    }
    inputL.flush();
    inputR.flush();

    setInput({
      durationSec: decoded.duration,
      peakL: inputL.snapshot().peak,
      peakR: inputR.snapshot().peak,
    });
  }, [decodeReady, getDecodedPlayback, stores]);

  useEffect(() => {
    stores.protectedL.reset();
    stores.protectedR.reset();
    readyRef.current = false;
    pendingProtectedRef.current = [];
    backfillTokenRef.current += 1;
  }, [sourceFile, stores]);

  // 이벤트(초당 ~100회)마다 새 Float32Array를 만들지 않기 위한 재사용 버퍼 — addBlock()은
  // 값을 즉시 버킷으로 소화하고 참조를 보관하지 않으므로 안전하다(useChannelWaveStreams의
  // chunkScratch와 같은 규약). 프레임 크기가 바뀔 때만 다시 잡는다.
  const protectedScratchRef = useRef<{ l: Float32Array; r: Float32Array } | null>(null);

  const applyProtectedEvent = useCallback((ev: ProtectedEvent) => {
    sampleRateRef.current = ev.sampleRate;
    const { protectedL, protectedR } = stores;
    const samplesPerFrame = ev.processed.length / CHANNELS;
    const startSec = (ev.frameIndex * samplesPerFrame) / ev.sampleRate;

    let scratch = protectedScratchRef.current;
    if (!scratch || scratch.l.length !== samplesPerFrame) {
      scratch = { l: new Float32Array(samplesPerFrame), r: new Float32Array(samplesPerFrame) };
      protectedScratchRef.current = scratch;
    }
    readChannelFloat32(ev.processed, CHANNELS, 0, scratch.l);
    readChannelFloat32(ev.processed, CHANNELS, 1, scratch.r);
    protectedL.addBlock(scratch.l, startSec, ev.sampleRate);
    protectedR.addBlock(scratch.r, startSec, ev.sampleRate);
    protectedL.flush();
    protectedR.flush();
  }, [stores]);

  useEffect(() => {
    if (!input) return;
    const token = ++backfillTokenRef.current;
    let cancelled = false;

    // Input과 같은 격자로 맞춘다 — bucketSecFor는 순수함수라 같은 durationSec엔 항상 같은 폭을 낸다.
    const bucketSec = bucketSecFor(input.durationSec);
    const { protectedL, protectedR } = stores;
    protectedL.reset();
    protectedR.reset();
    protectedL.setInitialBucketSec(bucketSec);
    protectedR.setInitialBucketSec(bucketSec);

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
                protectedL.addBlock(dataL, 0, header.sampleRate);
                protectedR.addBlock(dataR, 0, header.sampleRate);
                protectedL.flush();
                protectedR.flush();
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
  }, [input, getProtectedBlob, applyProtectedEvent, stores]);

  useEffect(() => {
    const off = subscribeCaptureStream((ev: CaptureStreamEvent) => {
      if (ev.type === "reset") {
        stores.protectedL.reset();
        stores.protectedR.reset();
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
  }, [subscribeCaptureStream, applyProtectedEvent, stores]);

  const showL = channelMode !== "R";
  const showR = channelMode !== "L";

  /**
   * uPlot에 싣는 데이터는 **x 도메인의 양 끝 두 점뿐**이다. 네 시리즈 모두 paths:()=>null이고
   * 실제 스트로크는 envelopeOverlayPlugin이 스토어에서 직접 읽어 그리므로 u.data에 실값이
   * 필요 없다. 그렇다고 비워 둘 수는 없는데, UPlotChart의 줌 판정(isZoomed)이 u.data[0]의
   * 길이가 2 이상일 때만 동작하고 uPlot 기본 더블클릭 리셋(autoScaleX)도 이 extent로
   * 돌아가기 때문이다 — 딱 그 두 가지를 위한 두 점이다.
   */
  const chartData = useMemo<uPlot.AlignedData | null>(() => {
    if (!input) return null;
    const blank = [null, null];
    return [[0, input.durationSec], blank, blank, blank, blank] as unknown as uPlot.AlignedData;
  }, [input]);

  const xRange = useMemo<[number, number] | null>(
    () => (input ? [0, input.durationSec] : null),
    [input],
  );

  const yRange = useMemo<[number, number] | null>(() => {
    if (!input) return null;
    // 하한(Y_MIN_SPAN)을 피크에 먼저 반영하고 넘기므로 헬퍼의 minSpan은 0이다.
    const peak = Math.max(
      Y_MIN_SPAN,
      showL ? input.peakL : 0,
      showR ? input.peakR : 0,
    );
    return symmetricYRange(peak, 0);
  }, [input, showL, showR]);

  const options = useMemo<UPlotOptions | null>(() => {
    if (!input) return null;
    // 네 시리즈 모두 uPlot의 기본 경로 빌드를 끈다 — 실제 스트로크는 envelopeOverlayPlugin이
    // u.series[idx]의 show/stroke/width/points만 빌려 캔버스에 직접 그린다(u.data[idx]는 안 읽음).
    // points는 Temperature/Excursion과 같은 규약이다 — 지름(CSS px)만 주면 오버레이가 uPlot과
    // 동일한 기준(점 간격이 촘촘해지면 생략)으로 알아서 켜고 끈다. 원본은 배경 기준선이라 점을
    // 띄우지 않는다.
    const inputSeries = (label: string, color: string): uPlot.Series => ({
      label, stroke: `${color}D9`, width: 1, spanGaps: true,
      paths: () => null,
      points: { show: false },
    });
    const protectedSeries = (label: string, color: string): uPlot.Series => ({
      label, stroke: color, width: 1.8, spanGaps: true,
      paths: () => null,
      points: { size: 4, fill: color },
    });
    const { inputL, inputR, protectedL, protectedR } = stores;
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
        buildValueAxis({ size: 56 }),
      ],
      plugins: [
        // 배열 순서가 z-order다 — 배경인 원본을 먼저, 보호 결과를 그 위에 얹는다.
        envelopeOverlayPlugin([
          { store: inputL, seriesIdx: 1 },
          { store: inputR, seriesIdx: 2 },
          { store: protectedL, seriesIdx: 3 },
          { store: protectedR, seriesIdx: 4 },
        ]),
        zoomPlugin({ getFullXRange: () => [0, input.durationSec] }),
        // u.data가 비어 있으므로 네 값 모두 인덱스가 아니라 **시각으로** 조회한다 — 커서
        // 픽셀을 그대로 환산한 시각이라 x축 눈금과 언제나 일치한다.
        tooltipPlugin({
          unit: "", decimals: 3,
          virtualSeries: [
            { label: "Input L", seriesIdx: 1, resolve: (t) => inputL.valueAt(t) },
            { label: "Input R", seriesIdx: 2, resolve: (t) => inputR.valueAt(t) },
            { label: "Protected L", seriesIdx: 3, resolve: (t) => protectedL.valueAt(t) },
            { label: "Protected R", seriesIdx: 4, resolve: (t) => protectedR.valueAt(t) },
          ],
        }),
      ],
    };
  }, [input, stores]);

  const seriesShow = useMemo(
    () => [
      showL && !hiddenSeries.has(0),
      showR && !hiddenSeries.has(1),
      showL && !hiddenSeries.has(2),
      showR && !hiddenSeries.has(3),
    ],
    [showL, showR, hiddenSeries],
  );

  const placeholder = !sourceFile
    ? "Select an audio source to see the original waveform."
    : (input === null ? "Preparing original waveform…" : null);

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
        {options && chartData && xRange && yRange && !placeholder ? (
          <div className="flex-1 min-h-0">
            <UPlotChart
              options={options}
              data={chartData}
              yRange={yRange}
              xRange={xRange}
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
