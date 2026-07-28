"use client";

// 차트 상세(자세히 보기) 뷰 — 대시보드에서 특정 차트의 확대 버튼을 누르면 전체 화면 페이지처럼
// 전환된다(별도 라우트가 아니라 DashboardClient가 소유한 라이브 데이터를 그대로 재사용하는
// 오버레이 — 정적 export/모바일 셸에서도 동작하고 재생 중 실시간 갱신을 유지한다).
// 메인 차트(Temperature/Excursion)와 캡처된 오디오의 채널들을 "표시 항목" 드로어에서 동일하게
// 체크/해제(추가·제거) + 리사이즈할 수 있는 하나의 스택으로 구성한다 — ChannelSelectDrawer가
// 항목 목록을, ChannelStackView가 실제 스택 렌더링을 맡는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Rows3, ShieldAlert, Thermometer, X } from "lucide-react";
import type { AnalysisFrame } from "@/features/audio/types";
import { cn } from "@/shared/lib/utils";
import { useOverlayTransition } from "@/shared/hooks/useOverlayTransition";
import { useCtrlBToggle } from "@/shared/hooks/useCtrlBToggle";
import FullscreenOverlay from "@/shared/components/overlay/FullscreenOverlay";
import { useErrorPopup } from "@/shared/components/error-popup/ErrorPopupContext";
import { BYTES_PER_SAMPLE, INT16_SCALE } from "@/features/audio/lib/engine/core";
import { appendWindowed, decodeWavRange, peekWavHeader } from "@/features/audio/lib/codec/wav-incremental";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import { channelLabel, channelColor } from "@/features/audio/lib/render/channel-meta";
import TemperatureChart from "./TemperatureChart";
import ExcursionChart from "./ExcursionChart";
import ChannelSelectDrawer, { type DrawerEntry } from "../channel/ChannelSelectDrawer";
import ChannelStackView, { type StackItem } from "../channel/ChannelStackView";
import { ChannelWaveformCanvas } from "../channel/ChannelWaveformCanvas";
import { channelStats, type WaveformWindow } from "@/features/audio/lib/render/waveform";
import { ProtectedComparePanel } from "../channel/ProtectedComparePanel";

// 채널 라이브 뷰가 화면에 유지하는 슬라이딩 윈도우 길이(초) — 이보다 오래된 샘플은 버려서
// 세션이 길어져도 채널당 메모리 사용량이 상한(윈도우 크기)을 넘지 않게 한다.
const LIVE_WINDOW_SEC = 30;

const METRIC_ID = "metric";
// 보호 감쇠 전/후 비교 뷰 — 원본 채널(channel 섹션)이 아니라 분석 결과라 metric 섹션에 둔다.
const PROTECT_ID = "protected-compare";
const channelId = (ch: number) => `ch:${ch}`;
const parseChannelId = (id: string) => Number(id.slice(3));

/** 채널 뷰 헤더 — WavHeader 전체가 아니라 UI/축 계산에 필요한 만큼만 들고 있는다. */
interface ChannelHeader {
  channels: number;
  sampleRate: number;
  durationSec: number;
}

export type DetailMetric = "temperature" | "excursion";

interface Props {
  metric: DetailMetric;
  frames: AnalysisFrame[];
  currentTime: number;
  isActive: boolean;
  audioDuration?: number | null;
  /** temperature 상세 뷰의 WARN/DANGER 임계선 — Calibration.tempWarn/tempDanger */
  warnThreshold?: number;
  dangerThreshold?: number;
  /**
   * 현재 캡처 세션의 전 채널 원본 PCM을 WAV Blob으로 스냅샷 반환 (WaveformPlayer/MicrophonePlayer
   * 핸들의 exportRecordedAudio). 채널을 새로 선택했을 때의 1회 백필과, 과거 구간 온디맨드
   * 조회에만 쓰인다 — 없으면(캡처 이력 없음) 드로어에 메인 차트 항목만 나열된다.
   */
  getChannelsBlob?: () => Blob | null;
  /**
   * 원본 캡처 청크 실시간 스트림 구독(WaveformPlayer/MicrophonePlayer 핸들의
   * subscribeCaptureStream) — 채널 뷰가 폴링 없이 청크 도착 즉시 갱신되는 핵심 경로.
   */
  subscribeChannelStream?: (fn: CaptureStreamListener) => () => void;
  /**
   * 보호 감쇠가 적용된 PCM(엔진이 buf를 In/Out으로 되쓴 결과)의 WAV 스냅샷. 없으면
   * "보호 감쇠 비교" 항목이 드로어에 나타나지 않는다.
   */
  getProtectedBlob?: () => Blob | null;
  /**
   * 재생 대상 음원 파일. 보호 감쇠 비교 뷰가 재생 전에 원본 전체 파형을 깔기 위해 직접
   * 디코드한다 — 캡처 스트림은 재생이 진행된 만큼만 도착해 전체 구간의 소스가 될 수 없다.
   */
  sourceFile?: File | null;
  onClose: () => void;
}

export default function ChartDetailOverlay({
  metric,
  frames,
  currentTime,
  isActive,
  audioDuration,
  warnThreshold,
  dangerThreshold,
  getChannelsBlob,
  subscribeChannelStream,
  getProtectedBlob,
  sourceFile,
  onClose,
}: Props) {
  const isTemp = metric === "temperature";
  const title = isTemp ? "Temperature" : "Excursion";
  const Icon = isTemp ? Thermometer : Activity;
  const accent = isTemp ? "#0B4171" : "#10B981";

  // 진입/이탈 애니메이션 + ESC 닫기 — FullscreenOverlay 공용 셸과 함께 사용한다.
  const { show, close } = useOverlayTransition(onClose);
  const { showError } = useErrorPopup();

  // ── 표시 항목 드로어 — 메인 차트(metric) + 캡처 버퍼의 채널들을 같은 방식으로 체크/해제한다.
  // 기본값은 메인 차트만 선택된 상태(기존 동작과 동일하게 열자마자 차트가 보인다).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set([METRIC_ID]));

  const wantedChannels = useMemo(
    // 채널이 아닌 항목(메인 차트·보호 비교)은 parseChannelId에 넘기면 NaN이 된다 — 먼저 뺀다.
    () => Array.from(selected)
      .filter((id) => id !== METRIC_ID && id !== PROTECT_ID)
      .map(parseChannelId).sort((a, b) => a - b),
    [selected],
  );
  const hasSelectedChannel = wantedChannels.length > 0;

  // ── 채널 헤더 + 채널별 라이브 윈도우(최근 LIVE_WINDOW_SEC초) — 전부 push로 갱신된다 ──────
  const [header, setHeader] = useState<ChannelHeader | null>(null);
  const [windows, setWindows] = useState<Map<number, WaveformWindow>>(new Map());
  const [channelError, setChannelError] = useState<string | null>(null);
  const [headerLoading, setHeaderLoading] = useState(false);

  // 현재 렌더의 wantedChannels를 청크 콜백(안정된 참조로 한 번만 구독)이 항상 최신으로
  // 읽을 수 있게 ref로 미러링한다 — 매 청크마다 구독을 재생성하지 않기 위함.
  const wantedChannelsRef = useRef<number[]>(wantedChannels);
  useEffect(() => { wantedChannelsRef.current = wantedChannels; }, [wantedChannels]);
  // 세션 누적 프레임 수 — 청크가 들어올 때마다 늘어나며, durationSec = 이 값/sampleRate.
  const totalFramesRef = useRef(0);
  // 이미 최근 LIVE_WINDOW_SEC초를 백필(seed)한 채널 집합 — 한 번만 백필하고, 그 뒤로는
  // 청크 push로만 이어붙인다.
  const seededRef = useRef<Set<number>>(new Set());

  // 선택 해제된 채널은 캐시(윈도우/시드 여부)에서 지워 메모리를 되돌린다 — 나중에 다시
  // 선택되면 처음 선택했을 때와 동일하게 최근 LIVE_WINDOW_SEC초를 다시 백필한다.
  useEffect(() => {
    const wantedSet = new Set(wantedChannels);
    for (const ch of seededRef.current) {
      if (!wantedSet.has(ch)) seededRef.current.delete(ch);
    }
    setWindows((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const ch of prev.keys()) {
        if (!wantedSet.has(ch)) { next.delete(ch); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [wantedChannels]);

  // 캡처 청크가 들어올 때마다 즉시 호출된다(Temperature/Excursion과 동일한 push 타이밍) —
  // 선택된 채널의 새 샘플만 뽑아 라이브 윈도우에 이어붙인다. 폴링이 없으므로 렌더 갱신
  // 단위가 곧 실제 캡처 청크 단위(예: 10ms)가 된다.
  const handleChunk = useCallback((chunk: ArrayBuffer, channels: number, sampleRate: number) => {
    const bytesPerFrame = channels * BYTES_PER_SAMPLE;
    const frameCount = Math.floor(chunk.byteLength / bytesPerFrame);
    if (frameCount === 0) return;
    totalFramesRef.current += frameCount;
    const durationSec = totalFramesRef.current / sampleRate;
    setHeader({ channels, sampleRate, durationSec });

    const wanted = wantedChannelsRef.current;
    if (wanted.length === 0) return;

    const view = new DataView(chunk);
    const maxSamples = Math.round(LIVE_WINDOW_SEC * sampleRate);
    setWindows((prev) => {
      const next = new Map(prev);
      for (const ch of wanted) {
        if (!seededRef.current.has(ch)) continue; // 백필 전 — 백필이 곧 지금까지를 커버
        const incoming = new Float32Array(frameCount);
        for (let i = 0; i < frameCount; i++) {
          incoming[i] = view.getInt16(i * bytesPerFrame + ch * BYTES_PER_SAMPLE, true) / INT16_SCALE;
        }
        const existing = next.get(ch) ?? { data: new Float32Array(0), startSec: durationSec };
        const merged = appendWindowed(existing.data, incoming, maxSamples);
        const startSec = Math.max(0, durationSec - merged.length / sampleRate);
        next.set(ch, { data: merged, startSec });
      }
      return next;
    });
  }, []);

  const handleStreamEvent = useCallback((ev: CaptureStreamEvent) => {
    if (ev.type === "reset") {
      totalFramesRef.current = 0;
      seededRef.current.clear();
      setWindows(new Map());
      setChannelError(null);
      setHeader({ channels: ev.channels, sampleRate: ev.sampleRate, durationSec: 0 });
      return;
    }
    // "protected"(보호 감쇠 PCM)는 이 뷰의 관심사가 아니다 — 원본 채널 파형만 그린다.
    if (ev.type !== "chunk") return;
    handleChunk(ev.chunk, ev.channels, ev.sampleRate);
  }, [handleChunk]);

  // 채널 뷰가 필요한 동안(드로어가 열려 있거나 채널이 선택돼 있는 동안) 원본 캡처 청크
  // 스트림을 구독한다 — 더 이상 setInterval로 Blob을 다시 열어보지 않는다.
  useEffect(() => {
    if (!subscribeChannelStream) return;
    if (!drawerOpen && !hasSelectedChannel) return;
    return subscribeChannelStream(handleStreamEvent);
  }, [subscribeChannelStream, drawerOpen, hasSelectedChannel, handleStreamEvent]);

  // 드로어를 열었을 때 채널 목록/길이를 즉시 보여주기 위한 1회성 헤더 확인 — 그 뒤로는
  // 위 구독이 청크가 들어올 때마다 header를 계속 최신으로 유지한다.
  useEffect(() => {
    if (!drawerOpen || !getChannelsBlob) return;
    let cancelled = false;
    setHeaderLoading(true);
    (async () => {
      try {
        const blob = getChannelsBlob();
        if (!blob) return;
        const h = await peekWavHeader(blob);
        if (!h || cancelled) return;
        if (totalFramesRef.current === 0) totalFramesRef.current = Math.round(h.durationSec * h.sampleRate);
        setHeader((prev) => (prev && prev.durationSec >= h.durationSec ? prev : {
          channels: h.channels, sampleRate: h.sampleRate, durationSec: h.durationSec,
        }));
      } catch {
        if (!cancelled) {
          setChannelError("Failed to read channel header.");
          showError("Failed to read channel header.");
        }
      } finally {
        if (!cancelled) setHeaderLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [drawerOpen, getChannelsBlob, showError]);

  // 채널을 새로 선택한 순간 — 청크 스트림에는 "지금부터"만 쌓이므로, 최근 LIVE_WINDOW_SEC초는
  // getChannelsBlob()에서 딱 한 번만 백필한다(세션 전체를 훑지 않고 그 구간만 디코딩).
  useEffect(() => {
    const toSeed = wantedChannels.filter((ch) => !seededRef.current.has(ch));
    if (toSeed.length === 0 || !getChannelsBlob) return;
    let cancelled = false;
    (async () => {
      const blob = getChannelsBlob();
      if (!blob) return;
      const h = await peekWavHeader(blob);
      if (!h || cancelled) return;
      const seedStart = Math.max(0, h.durationSec - LIVE_WINDOW_SEC);
      const seeded = await Promise.all(
        toSeed.map(async (ch) => {
          const data = await decodeWavRange(blob, h, ch, seedStart, h.durationSec);
          return [ch, { data, startSec: seedStart }] as const;
        }),
      );
      if (cancelled) return;
      setWindows((prev) => {
        const next = new Map(prev);
        for (const [ch, w] of seeded) next.set(ch, w);
        return next;
      });
      toSeed.forEach((ch) => seededRef.current.add(ch));
      setHeader((prev) => (prev && prev.durationSec >= h.durationSec ? prev : {
        channels: h.channels, sampleRate: h.sampleRate, durationSec: h.durationSec,
      }));
    })();
    return () => { cancelled = true; };
  }, [wantedChannels, getChannelsBlob]);

  // 과거 구간(라이브 윈도우 밖)을 사용자가 확대했을 때만 호출되는 온디맨드 디코딩 — 요청한
  // 구간 길이에만 비용이 비례한다. header를 캐시하지 않고 그때그때 새로 peek해 최신 길이를 쓴다.
  const fetchRangeFor = useCallback(async (ch: number, startSec: number, endSec: number): Promise<Float32Array> => {
    if (!getChannelsBlob) return new Float32Array(0);
    const blob = getChannelsBlob();
    if (!blob) return new Float32Array(0);
    const h = await peekWavHeader(blob);
    if (!h) return new Float32Array(0);
    return decodeWavRange(blob, h, ch, startSec, endSec);
  }, [getChannelsBlob]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Ctrl/Cmd+B — 표시 항목 드로어 열림/숨김 토글 (기존 우측 드로어들과 동일한 단축키 규약)
  useCtrlBToggle(() => setDrawerOpen((prev) => !prev));

  const channelCount = header?.channels ?? 0;

  // 드로어 항목 목록 — 메인 차트 1개 + 채널 N개. 이 배열의 순서가 곧 "기본 순서"다
  // (메인 차트 → 채널 오름차순), 아래 order 상태로 사용자가 자유롭게 재배치할 수 있다.
  const entries = useMemo<DrawerEntry[]>(() => {
    const metricEntry: DrawerEntry = {
      id: METRIC_ID,
      section: "metric",
      name: title,
      role: isTemp ? "Temperature" : "Excursion",
      color: accent,
      icon: Icon,
    };
    // 보호 감쇠 비교 — 엔진이 감쇠 결과를 돌려주는 경로가 있을 때만 노출한다.
    const protectEntry: DrawerEntry[] = getProtectedBlob
      ? [{
          id: PROTECT_ID,
          section: "metric",
          name: "Protection Attenuation",
          role: "Before/After Compare",
          color: "#F59E0B",
          icon: ShieldAlert,
        }]
      : [];
    const channelEntries: DrawerEntry[] = Array.from({ length: channelCount }, (_, ch) => {
      const { name, role } = channelLabel(ch);
      return { id: channelId(ch), section: "channel", name, role, color: channelColor(ch) };
    });
    return [metricEntry, ...protectEntry, ...channelEntries];
  }, [title, isTemp, accent, Icon, channelCount, getProtectedBlob]);

  // 사용자가 드래그로 재배치한 항목 순서 — 기본값은 entries가 나열되는 순서(메인 차트 →
  // 채널 오름차순) 그대로다. 채널이 새로 발견되면(헤더 갱신) 기존 배치는 건드리지 않고
  // 새 id만 끝에 덧붙인다.
  const [order, setOrder] = useState<string[]>(() => entries.map((e) => e.id));
  useEffect(() => {
    setOrder((prev) => {
      const known = new Set(prev);
      const missing = entries.filter((e) => !known.has(e.id)).map((e) => e.id);
      return missing.length === 0 ? prev : [...prev, ...missing];
    });
  }, [entries]);

  const reorder = useCallback((visibleIds: string[]) => {
    setOrder((prev) => {
      const visible = new Set(visibleIds);
      let vi = 0;
      return prev.map((id) => (visible.has(id) ? visibleIds[vi++] : id));
    });
  }, []);

  // entries를 order 순서로 재배열 — 드로어 목록/스택 모두 이 순서를 그대로 따른다.
  const orderedEntries = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return order.map((id) => byId.get(id)).filter((e): e is DrawerEntry => e !== undefined);
  }, [order, entries]);

  // 선택된 항목만, 사용자가 재배치한 순서 그대로 스택에 렌더링 — 체크/해제가 곧 추가/제거다.
  const stackItems = useMemo<StackItem[]>(() => {
    const items: StackItem[] = [];
    for (const entry of orderedEntries) {
      if (!selected.has(entry.id)) continue;
      if (entry.id === PROTECT_ID) {
        items.push({
          id: entry.id,
          header: (
            <>
              <ShieldAlert size={13} style={{ color: entry.color }} className="shrink-0" />
              <span className="text-xs font-semibold text-iron-800 font-mono">{entry.name}</span>
              <span className="text-[11px] text-iron-400">{entry.role}</span>
            </>
          ),
          content: subscribeChannelStream ? (
            <ProtectedComparePanel
              subscribeCaptureStream={subscribeChannelStream}
              sourceFile={sourceFile}
              getProtectedBlob={getProtectedBlob}
              bare
            />
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-iron-400">
              No capture session — nothing to compare.
            </div>
          ),
          defaultHeight: 240,
          minHeight: 180,
          maxHeight: 480,
        });
        continue;
      }
      if (entry.section === "metric") {
        items.push({
          id: entry.id,
          header: (
            <>
              <Icon size={14} style={{ color: accent }} className="shrink-0" />
              <span className="text-xs font-semibold text-iron-800">{title}</span>
            </>
          ),
          content: isTemp ? (
            <TemperatureChart
              frames={frames}
              currentTime={currentTime}
              isActive={isActive}
              streaming
              audioDuration={audioDuration}
              warnThreshold={warnThreshold}
              dangerThreshold={dangerThreshold}
            />
          ) : (
            <ExcursionChart
              frames={frames}
              currentTime={currentTime}
              isActive={isActive}
              streaming
              audioDuration={audioDuration}
            />
          ),
          defaultHeight: 360,
          minHeight: 220,
          maxHeight: 720,
        });
        continue;
      }

      const ch = parseChannelId(entry.id);
      const liveWindow = windows.get(ch);
      items.push({
        id: entry.id,
        header: (
          <>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
            <span className="text-xs font-semibold text-iron-800 font-mono">{entry.name}</span>
            <span className="text-[11px] text-iron-400">{entry.role}</span>
            {liveWindow && (
              <span className="ml-auto text-[10px] font-mono text-iron-400">
                {(() => {
                  const { peak, rms } = channelStats(liveWindow.data);
                  return `peak ${peak.toFixed(4)} · rms ${rms.toFixed(4)}`;
                })()}
              </span>
            )}
          </>
        ),
        content: liveWindow && header ? (
          <ChannelWaveformCanvas
            color={entry.color}
            sampleRate={header.sampleRate}
            totalDurationSec={header.durationSec}
            liveWindow={liveWindow}
            fetchRange={(s, e) => fetchRangeFor(ch, s, e)}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-iron-400">
            {channelError ? "Unable to load channel waveform." : "Loading channel waveform…"}
          </div>
        ),
        defaultHeight: 200,
        minHeight: 140,
        maxHeight: 480,
      });
    }
    return items;
  }, [
    orderedEntries, selected, Icon, accent, title, isTemp, frames, currentTime, isActive,
    audioDuration, warnThreshold, dangerThreshold, windows, header, channelError, fetchRangeFor,
    subscribeChannelStream, getProtectedBlob, getChannelsBlob, sourceFile,
  ]);

  return (
    <FullscreenOverlay show={show} ariaLabel={`${title} detail view`}>
      {/* 상단 바 */}
      <header className="shrink-0 h-14 px-3 sm:px-5 flex items-center gap-3 border-b border-iron-100 bg-white">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={16} style={{ color: accent }} className="shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-iron-900 truncate">{title}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDrawerOpen((prev) => !prev)}
          aria-pressed={drawerOpen}
          title="Visible items (Ctrl/Cmd+B)"
          aria-label="Visible items"
          className={cn(
            "ml-auto flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-sm transition",
            drawerOpen ? "bg-brand-blue/10 text-brand-blue" : "text-iron-500 hover:bg-iron-100 hover:text-iron-900",
          )}
        >
          <Rows3 className="w-4 h-4" />
          <span className="hidden sm:inline">Visible items</span>
          {selected.size > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-brand-blue/15 text-[10px] font-semibold tabular-nums">
              {selected.size}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="flex items-center justify-center w-9 h-9 rounded-lg text-iron-400 hover:bg-iron-100 hover:text-iron-700 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* 표시 항목 스택 — 메인 차트/채널 모두 동일한 방식으로 추가·제거·리사이즈된다.
          하단 패딩은 재생 중에도 그대로 보이는 플로팅 플레이어 독(elevated)에 가리지 않기 위함
          (대시보드 main의 pb-28 lg:pb-32와 동일한 여백). */}
      <div className="flex-1 min-h-0 p-3 sm:p-5 pb-28 lg:pb-32">
        <ChannelStackView
          items={stackItems}
          onReorder={reorder}
          emptyLabel="Select a chart or channel from the items drawer to display it here."
        />
      </div>

      <ChannelSelectDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        entries={orderedEntries}
        selected={selected}
        onToggle={toggle}
        loading={headerLoading && !header}
        error={channelError}
      />
    </FullscreenOverlay>
  );
}
