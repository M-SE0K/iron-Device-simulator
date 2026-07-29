"use client";

// 차트 상세(자세히 보기) 뷰 — 대시보드에서 특정 차트의 확대 버튼을 누르면 전체 화면 페이지처럼
// 전환된다(별도 라우트가 아니라 DashboardClient가 소유한 라이브 데이터를 그대로 재사용하는
// 오버레이 — 정적 export/데스크톱 셸에서도 동작하고 재생 중 실시간 갱신을 유지한다).
// 메인 차트(Temperature/Excursion)와 캡처된 오디오의 채널들을 "표시 항목" 드로어에서 동일하게
// 체크/해제(추가·제거) + 리사이즈할 수 있는 하나의 스택으로 구성한다 — ChannelSelectDrawer가
// 항목 목록을, ChannelStackView가 실제 스택 렌더링을 맡는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Rows3, ShieldAlert, Thermometer, X } from "lucide-react";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";
import { cn } from "@/shared/lib/utils";
import { useOverlayTransition } from "@/shared/hooks/useOverlayTransition";
import { useCtrlBToggle } from "@/shared/hooks/useCtrlBToggle";
import FullscreenOverlay from "@/shared/components/overlay/FullscreenOverlay";
import { BYTES_PER_SAMPLE, INT16_SCALE } from "@/features/audio/lib/engine/core";
import { readChannelSegment } from "@/features/audio/lib/render/capture-reader";
import { yieldToMain } from "@/shared/lib/yield-to-main";
import type { CaptureSnapshot, CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/types";
import { channelLabel, channelColor } from "@/features/audio/lib/render/channel-meta";
import TemperatureChart from "./TemperatureChart";
import ExcursionChart from "./ExcursionChart";
import ChannelSelectDrawer, { type DrawerEntry } from "../channel/ChannelSelectDrawer";
import ChannelStackView, { type StackItem } from "../channel/ChannelStackView";
import { ChannelStatsBadge, ChannelWaveformCanvas } from "../channel/ChannelWaveformCanvas";
import { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";
import { ProtectedComparePanel } from "../channel/ProtectedComparePanel";

/**
 * 백필 루프가 메인 스레드를 한 번에 붙잡는 시간 예산(ms). 캡처 콜백 주기(48 kHz/480
 * samples 기준 10 ms)의 절반 이하로 잡아, 예산을 넘겨 양보하는 시점까지 캡처 콜백이 최악
 * 경우에도 그 주기를 넘게 기다리지 않도록 한다. 이 예산을 넘기면 지금까지 쌓인 버킷을
 * flush하고 yieldToMain()으로 한 프레임 양보한 뒤 이어간다.
 */
const SLICE_BUDGET_MS = 4;

const METRIC_ID = "metric";
// 보호 감쇠 전/후 비교 뷰 — 원본 채널(channel 섹션)이 아니라 분석 결과라 metric 섹션에 둔다.
const PROTECT_ID = "protected-compare";
const channelId = (ch: number) => `ch:${ch}`;
const parseChannelId = (id: string) => Number(id.slice(3));

/**
 * 채널 뷰 헤더 — WavHeader 전체가 아니라 UI/축 계산에 필요한 만큼만 들고 있는다.
 * 세션 길이는 여기 두지 않는다: 청크마다 늘어나는 값이라 상태로 두면 초당 100번 리렌더가
 * 되고, 필요한 쪽(채널 파형)은 스토어 스냅샷에서 직접 읽는다.
 */
interface ChannelHeader {
  channels: number;
  sampleRate: number;
}

export type DetailMetric = "temperature" | "excursion";

interface Props {
  metric: DetailMetric;
  /** 대시보드와 같은 표시 데이터 스토어 — 상세 뷰의 차트도 여기에 직접 구독한다. */
  store: ChartStore;
  isActive: boolean;
  audioDuration?: number | null;
  /** temperature 상세 뷰의 WARN/DANGER 임계선 — Calibration.tempWarn/tempDanger */
  warnThreshold?: number;
  dangerThreshold?: number;
  /**
   * 현재 캡처 세션의 전 채널 원본 PCM을 복사 없이 들여다보는 스냅샷(파일 플레이어 핸들의
   * getCaptureSnapshot). 채널을 새로 선택했을 때의 1회 백필과, 과거 구간 온디맨드
   * 조회에만 쓰인다 — 없으면(캡처 이력 없음) 드로어에 메인 차트 항목만 나열된다.
   */
  getChannelsSnapshot?: () => CaptureSnapshot | null;
  /**
   * 원본 캡처 청크 실시간 스트림 구독(파일 플레이어 핸들의 subscribeCaptureStream) — 채널 뷰가 폴링 없이 청크 도착 즉시 갱신되는 핵심 경로.
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
  store,
  isActive,
  audioDuration,
  warnThreshold,
  dangerThreshold,
  getChannelsSnapshot,
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

  // ── 채널 헤더 + 채널별 파형 스토어(세션 전체 엔벨로프) — 전부 push로 갱신된다 ──────────
  const [header, setHeader] = useState<ChannelHeader | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);

  // 채널별 표시 스토어. 메인 차트의 ChartStore와 같은 역할이라 React 상태가 아니라 ref다 —
  // 청크가 도착해도 setState 없이 스토어가 직접 구독자(차트)에게 알린다.
  const storesRef = useRef<Map<number, ChannelWaveStore>>(new Map());
  const getStore = useCallback((ch: number): ChannelWaveStore => {
    let waveStore = storesRef.current.get(ch);
    if (!waveStore) {
      waveStore = new ChannelWaveStore();
      storesRef.current.set(ch, waveStore);
    }
    return waveStore;
  }, []);

  // 현재 렌더의 wantedChannels를 청크 콜백(안정된 참조로 한 번만 구독)이 항상 최신으로
  // 읽을 수 있게 ref로 미러링한다 — 매 청크마다 구독을 재생성하지 않기 위함.
  const wantedChannelsRef = useRef<number[]>(wantedChannels);
  useEffect(() => { wantedChannelsRef.current = wantedChannels; }, [wantedChannels]);
  // 세션 누적 프레임 수 — 청크가 들어올 때마다 늘어나며, durationSec = 이 값/sampleRate.
  const totalFramesRef = useRef(0);
  // 이미 세션 시작~현재를 백필(seed)한 채널 집합 — 한 번만 백필하고, 그 뒤로는 청크 push로만
  // 이어붙인다.
  const seededRef = useRef<Set<number>>(new Set());
  // 세션 세대 토큰 — 리셋 때 올려서, 진행 중이던 백필이 새 세션 스토어에 옛 데이터를 흘려
  // 넣지 못하게 한다.
  const sessionTokenRef = useRef(0);

  // 선택 해제된 채널은 스토어/시드 여부를 지워 메모리를 되돌린다 — 나중에 다시 선택되면
  // 처음 선택했을 때와 동일하게 세션 전체를 다시 백필한다.
  useEffect(() => {
    const wantedSet = new Set(wantedChannels);
    for (const ch of seededRef.current) {
      if (!wantedSet.has(ch)) seededRef.current.delete(ch);
    }
    for (const ch of storesRef.current.keys()) {
      if (!wantedSet.has(ch)) storesRef.current.delete(ch);
    }
  }, [wantedChannels]);

  // 캡처 청크가 들어올 때마다 즉시 호출된다(Temperature/Excursion과 동일한 push 타이밍) —
  // 선택된 채널의 새 샘플을 세션 시각 그대로 스토어에 넣는다. 폴링도, React 커밋도 없다.
  const handleChunk = useCallback((chunk: ArrayBuffer, channels: number, sampleRate: number) => {
    const bytesPerFrame = channels * BYTES_PER_SAMPLE;
    const frameCount = Math.floor(chunk.byteLength / bytesPerFrame);
    if (frameCount === 0) return;
    const startSec = totalFramesRef.current / sampleRate;
    totalFramesRef.current += frameCount;
    // 채널 수/샘플레이트가 그대로면 같은 객체를 돌려줘 리렌더를 건너뛴다 — 세션 길이는
    // 헤더에 담지 않으므로 이 setState는 세션당 사실상 한 번만 실제 갱신된다.
    setHeader((prev) => (
      prev && prev.channels === channels && prev.sampleRate === sampleRate
        ? prev
        : { channels, sampleRate }
    ));

    const wanted = wantedChannelsRef.current;
    if (wanted.length === 0) return;

    const view = new DataView(chunk);
    for (const ch of wanted) {
      if (ch >= channels) continue;
      const waveStore = getStore(ch);
      const samples = new Float32Array(frameCount);
      for (let i = 0; i < frameCount; i++) {
        samples[i] = view.getInt16(i * bytesPerFrame + ch * BYTES_PER_SAMPLE, true) / INT16_SCALE;
      }
      waveStore.addBlock(samples, startSec, sampleRate);
      waveStore.flush();
    }
  }, [getStore]);

  const handleStreamEvent = useCallback((ev: CaptureStreamEvent) => {
    if (ev.type === "reset") {
      sessionTokenRef.current += 1; // 진행 중이던 백필 무효화 — 새 세션은 0부터 라이브로만 채운다
      totalFramesRef.current = 0;
      seededRef.current.clear();
      storesRef.current.forEach((waveStore) => waveStore.reset());
      setChannelError(null);
      setHeader({ channels: ev.channels, sampleRate: ev.sampleRate });
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
  // 위 구독이 청크가 들어올 때마다 header를 계속 최신으로 유지한다. 스냅샷은 복사 없이
  // ref를 그대로 읽으므로(useCaptureSession.getCaptureSnapshot) 동기로 끝난다 — 더 이상
  // Blob을 만들고 WAV 헤더를 비동기로 파싱할 필요가 없다.
  useEffect(() => {
    if (!drawerOpen || !getChannelsSnapshot) return;
    const snap = getChannelsSnapshot();
    if (!snap) return;
    if (totalFramesRef.current === 0) totalFramesRef.current = snap.totalFrames;
    setHeader((prev) => (
      prev && prev.channels === snap.channels && prev.sampleRate === snap.sampleRate
        ? prev
        : { channels: snap.channels, sampleRate: snap.sampleRate }
    ));
  }, [drawerOpen, getChannelsSnapshot]);

  // 채널을 새로 선택한 순간 — 청크 스트림에는 "지금부터"만 쌓이므로, 세션 시작부터 지금까지를
  // getChannelsSnapshot()에서 딱 한 번 백필한다. 스토어는 버킷을 절대 시각으로 찾으므로 백필이
  // 진행되는 동안 도착한 라이브 청크(항상 백필 구간보다 뒤의 시각)와 섞여도 서로 덮어쓰지 않는다.
  //
  // 백필은 이펙트가 아니라 **배치 단위**로 살아 있다(대개 채널 1개 = 배치 1개 — 체크박스가
  // 한 번에 하나씩 토글되므로). 다른 채널을 추가로 선택했다고 진행 중인 배치를 취소해버리면
  // 그 채널의 앞부분이 영영 비게 된다(이미 seed 완료로 표시된 뒤라 재시도도 안 된다) — 그래서
  // 새 채널은 별도의 새 배치(이펙트 재실행)로 처리하고, 진행 중이던 배치는 그대로 둔다.
  // 중단 조건은 두 가지뿐: 배치 안의 채널이 선택 해제됐거나(스토어가 지워짐), 세션이
  // 리셋됐거나(토큰 변경) — stale()이 매 양보 지점마다 이 둘을 확인한다.
  useEffect(() => {
    const batch = wantedChannels.filter((ch) => !seededRef.current.has(ch));
    if (batch.length === 0 || !getChannelsSnapshot) return;
    batch.forEach((ch) => seededRef.current.add(ch)); // 재진입 방지 — 실패해도 라이브로는 계속 그린다

    const token = sessionTokenRef.current;
    const targets = batch.map((ch) => [ch, getStore(ch)] as const);
    // 스토어 인스턴스까지 비교한다 — 백필 중 해제했다가 다시 선택하면 새 스토어 + 새 배치가
    // 뜨므로, 옛 배치는 자기 채널의 스토어가 더 이상 현역이 아님을 보고 조용히 물러난다.
    const stale = () =>
      sessionTokenRef.current !== token
      || targets.some(([ch, s]) => storesRef.current.get(ch) !== s);

    (async () => {
      // 스냅샷은 복사 없이 rawCaptureRef.frames를 그대로 참조한다 — frames.length는
      // 이후에도 라이브 청크로 계속 자라지만, frames.length(스냅샷 시점)는 지금 이 호출
      // 시점의 값으로 고정해 둔다. 백필은 "지금까지"만 채우고, 그 이후 도착분은 라이브
      // 청크 경로(handleChunk)가 이어받으므로 이중 반영이나 누락이 없다.
      const snap = getChannelsSnapshot();
      if (!snap) return;
      const { channels, sampleRate, samplesPerFrame, frames } = snap;
      const liveTargets = targets.filter(([ch]) => ch < channels);
      if (liveTargets.length === 0) return;

      // 데이터는 인터리브라 프레임 하나를 읽으면 그 프레임의 모든 채널이 이미 손안에
      // 있다 — 프레임이 바깥, 채널이 안쪽이라야 배치 안의 채널 수만큼 같은 구간을
      // 중복해서 다시 훑지 않는다(예: ch0·ch1을 동시에 볼 때 절반으로 줄어든다).
      // scratch는 배치 전체에서 재사용 — 프레임마다 새 Float32Array를 할당하지 않는다.
      const scratch = new Float32Array(samplesPerFrame);
      const frameCount = frames.length;
      let deadline = performance.now() + SLICE_BUDGET_MS;

      for (let fi = 0; fi < frameCount; fi++) {
        const view = new Int16Array(frames[fi]);
        const startSec = (fi * samplesPerFrame) / sampleRate;
        for (const [ch, waveStore] of liveTargets) {
          for (let i = 0; i < samplesPerFrame; i++) {
            scratch[i] = view[i * channels + ch] / INT16_SCALE;
          }
          waveStore.addBlock(scratch, startSec, sampleRate);
        }
        // 시간 예산을 넘기면 지금까지 쌓인 걸 화면에 반영하고 한 프레임 양보한다 — 그
        // 사이 도착한 캡처 IPC 콜백(WASM 분석·차트 커밋)이 처리될 틈을 준다.
        if (performance.now() >= deadline) {
          liveTargets.forEach(([, s]) => s.flush());
          await yieldToMain();
          if (stale()) return;
          deadline = performance.now() + SLICE_BUDGET_MS;
        }
      }
      liveTargets.forEach(([, s]) => s.flush());

      if (sessionTokenRef.current !== token) return;
      setHeader((prev) => (
        prev && prev.channels === channels && prev.sampleRate === sampleRate
          ? prev
          : { channels, sampleRate }
      ));
    })();
  }, [wantedChannels, getChannelsSnapshot, getStore]);

  // 과거 구간(라이브 윈도우 밖)을 사용자가 확대했을 때만 호출되는 온디맨드 읽기 — 요청한
  // 구간 길이에만 비용이 비례한다. 스냅샷은 매 호출 새로 받아 최신 길이를 반영한다.
  const fetchRangeFor = useCallback(async (ch: number, startSec: number, endSec: number): Promise<Float32Array> => {
    if (!getChannelsSnapshot) return new Float32Array(0);
    const snap = getChannelsSnapshot();
    if (!snap) return new Float32Array(0);
    const startFrame = Math.max(0, Math.round(startSec * snap.sampleRate));
    const endFrame = Math.max(startFrame, Math.round(endSec * snap.sampleRate));
    return readChannelSegment(snap, ch, startFrame, endFrame);
  }, [getChannelsSnapshot]);

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
              store={store}
              isActive={isActive}
              audioDuration={audioDuration}
              warnThreshold={warnThreshold}
              dangerThreshold={dangerThreshold}
            />
          ) : (
            <ExcursionChart
              store={store}
              isActive={isActive}
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
      const waveStore = getStore(ch);
      items.push({
        id: entry.id,
        header: (
          <>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
            <span className="text-xs font-semibold text-iron-800 font-mono">{entry.name}</span>
            <span className="text-[11px] text-iron-400">{entry.role}</span>
            <ChannelStatsBadge store={waveStore} />
          </>
        ),
        content: header ? (
          <ChannelWaveformCanvas
            color={entry.color}
            sampleRate={header.sampleRate}
            store={waveStore}
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
    orderedEntries, selected, Icon, accent, title, isTemp, store, isActive,
    audioDuration, warnThreshold, dangerThreshold, header, channelError, fetchRangeFor, getStore,
    subscribeChannelStream, getProtectedBlob, sourceFile,
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
        error={channelError}
      />
    </FullscreenOverlay>
  );
}
