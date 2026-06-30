"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Header from "@/shared/components/Header";
import AudioUploader from "@/features/audio/components/AudioUploader";
import WaveformPlayer, { WaveformPlayerHandle } from "@/features/audio/components/WaveformPlayer";
import MicrophonePlayer from "@/features/audio/components/MicrophonePlayer";
import TemperatureChart from "@/features/audio/components/TemperatureChart";
import ExcursionChart from "@/features/audio/components/ExcursionChart";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry, MeasurementExport } from "@/features/audio/types";
import InputParameters, { InputParameterValues } from "@/features/audio/components/InputParameters";
import { cn } from "@/shared/lib/utils";

export default function DashboardPage({ useQueue }: { useQueue: boolean }) {
  const [status, setStatus]                   = useState<AppStatus>("idle");
  const [audioFile, setAudioFile]             = useState<File | null>(null);
  const [currentTime, setCurrentTime]         = useState(0);
  const [audioDuration, setAudioDuration]     = useState<number | null>(null);
  const [errorMsg, setErrorMsg]               = useState<string | null>(null);
  const [streamingFrames, setStreamingFrames] = useState<AnalysisFrame[]>([]);

  const [inputParams, setInputParams] = useState<InputParameterValues>({
    ampOutputPower: "",
    speakerModel: "",
  });
  const [inputMode, setInputMode] = useState<"file" | "mic">("file");

  // ── 분석 모드: realtime(실시간 추적) / batch(분석 후 렌더) ──────────────────
  const [analysisMode, setAnalysisMode]   = useState<"realtime" | "batch">("realtime");
  const [isAnalyzing, setIsAnalyzing]     = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  // 배치 분석으로 산출한 전체 output frame 시퀀스 (Reference / fidelity ground-truth)
  const referenceFramesRef = useRef<AnalysisFrame[]>([]);

  // ── WaveformPlayer ref (sendMessage 접근용) ──────────────────────────────
  const waveformRef = useRef<WaveformPlayerHandle>(null);
  // metrics 전송 간격 카운터 (10회에 1회 전송)
  const metricsCountRef    = useRef(0);
  const METRICS_INTERVAL   = 10;
  // 직전 프레임 정보 (metrics 메시지에 포함)
  const latestFrameIdxRef  = useRef(0);
  const latestAudioTimeRef = useRef(0);
  const latestRttMsRef     = useRef<number | null>(null);
  const latestSrvProcMsRef = useRef<number | null>(null);

  // ── 측정 모드 ─────────────────────────────────────────────────────────────
  const [isMeasuring, setIsMeasuring]         = useState(false);
  const [measureFrameCount, setMeasureFrameCount] = useState(0);
  const isMeasuringRef           = useRef(false);
  const measureLogsRef           = useRef<DebugLogEntry[]>([]);
  const measureStartTimeRef      = useRef<number>(0);
  const rawFramesRef             = useRef<{ time: number; temperature: [number, number]; excursion: [number, number] }[]>([]);
  const renderedFramesRef        = useRef<{ time: number; temperature: [number, number]; excursion: [number, number] }[]>([]);
  // 렌더 완료 시점 freshnessLag (handleEchartsRender에서 기록, per render tick)
  const renderFreshnessLogsRef   = useRef<number[]>([]);

  // ── freshness lag 계산용 refs ─────────────────────────────────────────────
  const currentTimeRef       = useRef(0);
  const latestFrameTimeRef   = useRef(0);
  // 측정 모드 중 streamingFrames 최대 길이 추적
  const maxStreamingLenRef   = useRef(0);
  // streamingFrames 길이 추적 (useCallback 의존성 회피)
  const streamingLenRef      = useRef(0);

  // ── Step 3: Output Queue ────────────────────────────────────────────────
  interface QueuedFrame {
    frame: AnalysisFrame;
    recvAt: number;
  }
  const outputQueueRef       = useRef<QueuedFrame[]>([]);
  const droppedFramesRef     = useRef(0);
  const renderTickCountRef   = useRef(0);
  const sourceCountSumRef    = useRef(0);
  const preservedEventsRef   = useRef(0);
  const eventLogRef          = useRef<{ audioTime: number; eventType: "temp_warn" | "temp_danger" | "exc_peak" }[]>([]);
  // Step 6: 직전 렌더 frame의 temperature (threshold crossing 감지용)
  const prevTempRef          = useRef<[number, number] | null>(null);
  // 렌더 업데이트 빈도 측정
  const lastRenderRateRef    = useRef<{ time: number; count: number }>({ time: 0, count: 0 });
  const renderUpdateRateRef  = useRef<number | null>(null);

  // ── 렌더 파이프라인 측정용 refs ──────────────────────────────────────────
  // 프레임 수신 시각 (WaveformPlayer → page.tsx handoff 시점)
  const frameRecvAtRef      = useRef<number>(0);
  // React useLayoutEffect 완료 시각
  const reactRenderAtRef    = useRef<number>(0);
  // 직전 RTT (로그 엔트리에 첨부용)
  const latestRttRef        = useRef<number | null>(null);
  // 직전 렌더 메트릭 (로그 엔트리에 첨부용)
  const latestRenderMetrics = useRef<{
    reactMs: number | null;
    echartsMs: number | null;
    totalRecvMs: number | null;
    totalE2eMs: number | null;
  }>({ reactMs: null, echartsMs: null, totalRecvMs: null, totalE2eMs: null });

  // ── 측정 모드 토글 + JSON 다운로드 ──────────────────────────────────────
  const handleMeasureToggle = useCallback(() => {
    if (!isMeasuringRef.current) {
      // 측정 시작
      measureLogsRef.current           = [];
      rawFramesRef.current             = [];
      renderedFramesRef.current        = [];
      renderFreshnessLogsRef.current   = [];
      measureStartTimeRef.current      = performance.now();
      maxStreamingLenRef.current       = 0;
      isMeasuringRef.current      = true;
      setIsMeasuring(true);
      setMeasureFrameCount(0);
    } else {
      // 측정 종료 → JSON 다운로드
      isMeasuringRef.current = false;
      setIsMeasuring(false);

      const logs        = measureLogsRef.current;
      const durationSec = parseFloat(
        ((performance.now() - measureStartTimeRef.current) / 1000).toFixed(3)
      );

      // ── 요약 통계 계산 ─────────────────────────────────────────────────
      const avg = (arr: number[]) =>
        arr.length > 0 ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
      const safeMin = (arr: number[]) =>
        arr.length > 0 ? parseFloat(Math.min(...arr).toFixed(2)) : null;
      const safeMax = (arr: number[]) =>
        arr.length > 0 ? parseFloat(Math.max(...arr).toFixed(2)) : null;
      const percentile = (arr: number[], p: number) => {
        if (arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.ceil(sorted.length * p / 100) - 1;
        return parseFloat(sorted[Math.max(0, idx)].toFixed(2));
      };
      const fullStats = (arr: number[]) => ({
        avg: avg(arr), min: safeMin(arr), max: safeMax(arr),
        p50: percentile(arr, 50), p95: percentile(arr, 95), p99: percentile(arr, 99),
      });

      const rttVals  = logs.map(l => l.rttMs).filter((v): v is number => v !== null);
      const srvVals  = logs.map(l => l.serverProcMs);
      const tempVals = logs.map(l => l.temperature);
      const excVals  = logs.map(l => l.excursion);
      const recvRenderVals = logs
        .map(l => l.totalRecvRenderMs)
        .filter((v): v is number => v !== null);
      const e2eVals  = logs
        .map(l => (l.rttMs !== null && l.totalRecvRenderMs !== null)
          ? parseFloat((l.rttMs + l.totalRecvRenderMs).toFixed(2))
          : null)
        .filter((v): v is number => v !== null);
      const freshnessVals = logs
        .map(l => l.freshnessLagMs)
        .filter((v): v is number => v !== null);
      const renderFreshnessVals = renderFreshnessLogsRef.current;

      const data: MeasurementExport = {
        meta: {
          recordedAt:             new Date().toISOString(),
          audioFile:              audioFile?.name ?? null,
          measurementDurationSec: durationSec,
          frameCount:             logs.length,
        },
        summary: {
          rtt:            fullStats(rttVals),
          serverProc:     { avg: avg(srvVals) },
          recvRender:     fullStats(recvRenderVals),
          e2e:            fullStats(e2eVals),
          freshnessLag:         fullStats(freshnessVals),
          renderFreshnessLag:   fullStats(renderFreshnessVals),
          temperature:    { avg: avg(tempVals) ?? 0, min: safeMin(tempVals) ?? 0, max: safeMax(tempVals) ?? 0 },
          excursion:      { avg: avg(excVals)  ?? 0, min: safeMin(excVals)  ?? 0, max: safeMax(excVals)  ?? 0 },
          maxStreamingFramesLen: maxStreamingLenRef.current,
          totalDroppedFrames:   droppedFramesRef.current,
          droppedFrameRatio:    logs.length > 0
            ? parseFloat((droppedFramesRef.current / (droppedFramesRef.current + logs.length)).toFixed(4))
            : null,
          avgSourceCount:       renderTickCountRef.current > 0
            ? parseFloat((sourceCountSumRef.current / renderTickCountRef.current).toFixed(2))
            : null,
          preservedEvents:      preservedEventsRef.current,
          eventLog:             eventLogRef.current,
        },
        frames:         logs,
        rawFrames:      rawFramesRef.current,
        renderedFrames: renderedFramesRef.current,
      };

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `iron-device-measurement-${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }, [audioFile]);

  // ── 측정 중 프레임 카운트 UI 갱신 (200ms 간격) ───────────────────────────
  useEffect(() => {
    if (!isMeasuring) return;
    const timer = setInterval(() => {
      setMeasureFrameCount(measureLogsRef.current.length);
    }, 200);
    return () => clearInterval(timer);
  }, [isMeasuring]);

  // ── 파일 선택 / 초기화 ────────────────────────────────────────────────────
  const handleFileSelected = useCallback((file: File) => {
    setAudioFile(file);
    setAudioDuration(null);
    setStreamingFrames([]);
    setCurrentTime(0);
    setStatus("idle");
    setErrorMsg(null);
    isMeasuringRef.current = false;
    setIsMeasuring(false);
    measureLogsRef.current = [];
    setMeasureFrameCount(0);
    referenceFramesRef.current = [];
    setBatchProgress({ done: 0, total: 0 });
    setIsAnalyzing(false);
  }, []);

  const handleReset = useCallback(() => {
    setAudioFile(null);
    setAudioDuration(null);
    setStreamingFrames([]);
    setCurrentTime(0);
    setStatus("idle");
    setErrorMsg(null);
    isMeasuringRef.current = false;
    setIsMeasuring(false);
    measureLogsRef.current = [];
    setMeasureFrameCount(0);
    referenceFramesRef.current = [];
    setBatchProgress({ done: 0, total: 0 });
    setIsAnalyzing(false);
  }, []);

  const handleInputModeChange = useCallback((mode: "file" | "mic") => {
    setInputMode(mode);
    setAudioDuration(null);
    setStreamingFrames([]);
    setCurrentTime(0);
    setStatus("idle");
    setErrorMsg(null);
    isMeasuringRef.current = false;
    setIsMeasuring(false);
    measureLogsRef.current = [];
    setMeasureFrameCount(0);
  }, []);

  const handleStreamStart = useCallback(() => {
    setStreamingFrames([]);
    outputQueueRef.current     = [];
    droppedFramesRef.current   = 0;
    renderTickCountRef.current = 0;
    sourceCountSumRef.current  = 0;
    preservedEventsRef.current = 0;
    eventLogRef.current        = [];
    prevTempRef.current        = null;
  }, []);

  // ── JSON 다운로드 헬퍼 ────────────────────────────────────────────────────
  const downloadJson = useCallback((obj: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  // ── 분석 모드 전환 ────────────────────────────────────────────────────────
  const handleAnalysisModeChange = useCallback((mode: "realtime" | "batch") => {
    setAnalysisMode(mode);
    setStreamingFrames([]);
    referenceFramesRef.current = [];
    setBatchProgress({ done: 0, total: 0 });
    setCurrentTime(0);
    setErrorMsg(null);
  }, []);

  // ── 배치 분석 실행: 전체 PCM 분석 → 전체 곡선 한 번에 렌더 ──────────────────
  const handleRunBatch = useCallback(async () => {
    const player = waveformRef.current;
    if (!player) return;
    setErrorMsg(null);
    setIsAnalyzing(true);
    setStatus("analyzing");
    setStreamingFrames([]);
    setBatchProgress({ done: 0, total: 0 });
    try {
      const frames = await player.runBatchAnalysis((done, total) => setBatchProgress({ done, total }));
      referenceFramesRef.current = frames;
      setStreamingFrames(frames);
      setStatus("ready");
    } catch (err) {
      console.error("[Dashboard] 배치 분석 실패:", err);
      setErrorMsg(`배치 분석 실패: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("error");
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  // ── Reference(전체 output frame 시퀀스) JSON 저장 ──────────────────────────
  const handleExportReference = useCallback(() => {
    const frames = referenceFramesRef.current;
    if (frames.length === 0) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadJson(
      {
        meta: {
          recordedAt:  new Date().toISOString(),
          audioFile:   audioFile?.name ?? null,
          sampleRate:  48000,
          frameCount:  frames.length,
          durationSec: audioDuration ?? (frames.length > 0 ? frames[frames.length - 1].time : 0),
          engineParams: {
            ampOutputPower: inputParams.ampOutputPower,
            speakerModel:   inputParams.speakerModel,
          },
        },
        frames: frames.map((f) => ({
          time:        f.time,
          temperature: f.temperature,
          excursion:   f.excursion,
        })),
      },
      `iron-device-reference-${timestamp}.json`,
    );
  }, [audioFile, audioDuration, inputParams, downloadJson]);

  // ── 렌더 윈도우 (저장/렌더 분리) ─────────────────────────────────────────
  // 실시간 스트리밍 상태(streamingFrames)는 최근 RENDER_WINDOW 프레임만 유지한다.
  // 이렇게 하면 매 렌더 틱의 배열 복사·차트 map()·ECharts setOption 비용이
  // 곡 길이와 무관하게 상수로 묶이고, freshness 중심의 슬라이딩 윈도우 뷰가 된다.
  // 전체 곡 곡선(overview)은 batch(분석 후 렌더) 모드가 담당한다
  // (handleRunBatch는 setStreamingFrames에 전체 시퀀스를 직접 주입 → 여기서 안 잘림).
  // ~62Hz 코얼레싱 기준 3000 ≈ 약 48초의 최근 구간.
  // ── 실험 토글: URL 쿼리로 제어 (측정 A/B용, 재빌드 불필요) ───────────────
  //   ?win=200000 → RENDER_WINDOW(버퍼 상한), ?lttb=0 → 차트 LTTB 끔
  //   미지정 시 기본값(win=3000, lttb=on) = 프로덕션 동작.
  const expParams    = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const RENDER_WINDOW = expParams?.get("win") ? Math.max(1, parseInt(expParams.get("win")!, 10) || 3000) : 3000;
  const LTTB_ENABLED  = expParams?.get("lttb") !== "0";
  // ── Step 3: Render Scheduler 주기 (ms) ──────────────────────────────────
  const RENDER_INTERVAL = 16;
  const isPlaying = status === "playing";

  // ── 프레임 수신 — useQueue 모드에 따라 큐 push 또는 FIFO append ────────
  const handleFrameReceived = useCallback((frame: AnalysisFrame) => {
    latestFrameTimeRef.current = frame.time;
    if (isMeasuringRef.current) {
      rawFramesRef.current.push({
        time:        frame.time,
        temperature: frame.temperature,
        excursion:   frame.excursion,
      });
    }
    if (useQueue) {
      outputQueueRef.current.push({ frame, recvAt: performance.now() });
    } else {
      // FIFO baseline: 수신 즉시 state append
      frameRecvAtRef.current = performance.now();
      if (isMeasuringRef.current) {
        renderedFramesRef.current.push({
          time:        frame.time,
          temperature: frame.temperature,
          excursion:   frame.excursion,
        });
      }
      setStreamingFrames((prev) => {
        const next = [...prev, frame];
        streamingLenRef.current = next.length;
        if (isMeasuringRef.current && next.length > maxStreamingLenRef.current) {
          maxStreamingLenRef.current = next.length;
        }
        return next.length > RENDER_WINDOW ? next.slice(-RENDER_WINDOW) : next;
      });
    }
  }, [useQueue]);

  // ── Step 5: Coalescing 함수 — bucket을 하나의 요약 frame으로 병합 ──────
  function coalesceFrames(bucket: QueuedFrame[]): AnalysisFrame {
    if (bucket.length === 1) return bucket[0].frame;

    const frames = bucket.map(q => q.frame);
    const latest = frames[frames.length - 1];

    return {
      ...latest,
      sourceCount: frames.length,
      timeStart:   frames[0].time,
      timeEnd:     latest.time,
      // 온도: 최신값 사용, 구간 내 최댓값 별도 보존
      temperatureMax: [
        Math.max(...frames.map(f => f.temperature[0])),
        Math.max(...frames.map(f => f.temperature[1])),
      ],
      // 익스커션: 최신값 사용, 구간 내 min/max envelope 보존
      excursionMin: [
        Math.min(...frames.map(f => f.excursion[0])),
        Math.min(...frames.map(f => f.excursion[1])),
      ],
      excursionMax: [
        Math.max(...frames.map(f => f.excursion[0])),
        Math.max(...frames.map(f => f.excursion[1])),
      ],
    };
  }

  // ── Step 6: 이벤트 감지 함수 ──────────────────────────────────────────────
  const TEMP_WARN   = 65;
  const TEMP_DANGER = 75;

  function detectEvents(bucket: QueuedFrame[], prevTemp: [number, number] | null): QueuedFrame[] {
    const events: QueuedFrame[] = [];
    for (let i = 0; i < bucket.length; i++) {
      const f = bucket[i].frame;
      const prev = i > 0 ? bucket[i - 1].frame : null;
      // 이전 온도: bucket 내 이전 frame 또는 직전 렌더 사이클의 마지막 온도
      const prevT = prev ? prev.temperature : prevTemp;

      // Temperature threshold crossing 감지
      if (prevT) {
        for (let ch = 0; ch < 2; ch++) {
          const was = prevT[ch];
          const now = f.temperature[ch];
          // WARN crossing (아래→위 또는 위→아래)
          if ((was < TEMP_WARN && now >= TEMP_WARN) || (was >= TEMP_WARN && now < TEMP_WARN)) {
            events.push(bucket[i]);
            bucket[i].frame = { ...f, isEvent: true, eventType: "temp_warn" };
            break;
          }
          // DANGER crossing
          if ((was < TEMP_DANGER && now >= TEMP_DANGER) || (was >= TEMP_DANGER && now < TEMP_DANGER)) {
            events.push(bucket[i]);
            bucket[i].frame = { ...f, isEvent: true, eventType: "temp_danger" };
            break;
          }
        }
      }
      // 이미 이벤트로 잡힌 frame은 skip
      if (bucket[i].frame.isEvent) continue;

      // Excursion peak 감지: 앞뒤 frame보다 절대값이 큰 극값
      if (prev && i < bucket.length - 1) {
        const next = bucket[i + 1].frame;
        for (let ch = 0; ch < 2; ch++) {
          const cur = Math.abs(f.excursion[ch]);
          if (cur > Math.abs(prev.excursion[ch]) && cur > Math.abs(next.excursion[ch])) {
            events.push(bucket[i]);
            bucket[i].frame = { ...f, isEvent: true, eventType: "exc_peak" };
            break;
          }
        }
      }
    }
    return events;
  }

  // ── Step 3: Render Scheduler — 16ms마다 큐를 drain하여 state update ─────
  useEffect(() => {
    if (!isPlaying) return;
    if (!useQueue) return; // FIFO 모드: 스케줄러 불필요

    // 재생 시작 시 큐 관련 카운터 초기화
    outputQueueRef.current    = [];
    droppedFramesRef.current  = 0;
    renderTickCountRef.current = 0;
    sourceCountSumRef.current = 0;
    preservedEventsRef.current = 0;
    eventLogRef.current        = [];
    prevTempRef.current        = null;
    lastRenderRateRef.current = { time: performance.now(), count: 0 };
    renderUpdateRateRef.current = null;

    const timer = setInterval(() => {
      const bucket = outputQueueRef.current;
      outputQueueRef.current = [];

      if (bucket.length === 0) return;

      // Step 6: 이벤트 감지
      const eventFrames = detectEvents(bucket, prevTempRef.current);

      // Step 5: Coalescing 정책 — 요약 frame으로 병합
      const renderFrame = coalesceFrames(bucket);
      const latest = bucket[bucket.length - 1];

      // 직전 온도 기록 (다음 tick의 crossing 감지용)
      prevTempRef.current = latest.frame.temperature;

      // 렌더링할 frame 목록: 이벤트 frame + coalesced frame
      // 이벤트 frame은 coalesced의 latest와 중복될 수 있으므로 제거
      const renderFrames: AnalysisFrame[] = [];
      for (const ev of eventFrames) {
        if (ev !== latest) {
          renderFrames.push(ev.frame);
        }
      }
      renderFrames.push(renderFrame); // coalesced frame은 항상 마지막

      // 큐 메트릭 업데이트
      const preserved = renderFrames.length - 1; // coalesced 제외한 보존 이벤트 수
      preservedEventsRef.current += preserved;
      for (const ev of eventFrames) {
        if (ev !== latest && ev.frame.eventType) {
          eventLogRef.current.push({ audioTime: ev.frame.time, eventType: ev.frame.eventType });
        }
      }
      const dropped = bucket.length - renderFrames.length;
      droppedFramesRef.current += Math.max(0, dropped);
      renderTickCountRef.current++;
      sourceCountSumRef.current += bucket.length;

      // recv 시각은 실제 수신 시점 기록 (정확한 latency 측정)
      frameRecvAtRef.current = latest.recvAt;

      if (isMeasuringRef.current) {
        for (const rf of renderFrames) {
          renderedFramesRef.current.push({
            time:        rf.time,
            temperature: rf.temperature,
            excursion:   rf.excursion,
          });
        }
      }

      setStreamingFrames((prev) => {
        const next = [...prev, ...renderFrames];
        streamingLenRef.current = next.length;
        if (isMeasuringRef.current && next.length > maxStreamingLenRef.current) {
          maxStreamingLenRef.current = next.length;
        }
        return next.length > RENDER_WINDOW ? next.slice(-RENDER_WINDOW) : next;
      });

      // 렌더 업데이트 빈도 측정 (1초 윈도우)
      const now = performance.now();
      const rateCheck = lastRenderRateRef.current;
      if (now - rateCheck.time >= 1000) {
        renderUpdateRateRef.current = parseFloat(
          ((renderTickCountRef.current - rateCheck.count) / ((now - rateCheck.time) / 1000)).toFixed(1)
        );
        lastRenderRateRef.current = { time: now, count: renderTickCountRef.current };
      }
    }, RENDER_INTERVAL);

    return () => clearInterval(timer);
  }, [isPlaying, useQueue]);

  // ── 디버그 업데이트 시 최신 rtt/srv 캐시 ────────────────────────────────
  const handleDebugUpdate = useCallback((info: Partial<StreamDebugInfo>) => {
    if (info.latestRttMs !== undefined)       { latestRttRef.current = info.latestRttMs; latestRttMsRef.current = info.latestRttMs; }
    if (info.serverProcessingMs !== undefined) latestSrvProcMsRef.current = info.serverProcessingMs;
  }, []);

  // ── React 렌더 완료 콜백 (TemperatureChart useLayoutEffect에서 호출) ──────
  const handleReactRender = useCallback((ts: number) => {
    reactRenderAtRef.current = ts;
  }, []);

  // ── ECharts 렌더 완료 콜백 (TemperatureChart onEvents rendered에서 호출) ──
  const handleEchartsRender = useCallback((ts: number) => {
    const echartsMs      = parseFloat((ts - reactRenderAtRef.current).toFixed(2));
    const totalRecvMs    = parseFloat((ts - frameRecvAtRef.current).toFixed(2));
    const rtt            = latestRttRef.current;
    const totalE2eMs     = rtt !== null
      ? parseFloat((rtt + totalRecvMs).toFixed(2))
      : null;

    // freshness lag 계산: 현재 오디오 재생 시각 - 최신 렌더된 frame의 time
    const audioNow       = currentTimeRef.current;
    const renderedTime   = latestFrameTimeRef.current;
    const freshnessLagMs = audioNow > 0 && renderedTime > 0
      ? parseFloat(((audioNow - renderedTime) * 1000).toFixed(2))
      : null;

    const reactMs = parseFloat((reactRenderAtRef.current - frameRecvAtRef.current).toFixed(2));
    latestRenderMetrics.current = { reactMs, echartsMs, totalRecvMs, totalE2eMs };

    if (isMeasuringRef.current && freshnessLagMs !== null) {
      renderFreshnessLogsRef.current.push(freshnessLagMs);
    }

    // ── 서버로 metrics 역전송 (METRICS_INTERVAL마다 1회) ─────────────────────
    metricsCountRef.current++;
    if (metricsCountRef.current % METRICS_INTERVAL === 0) {
      waveformRef.current?.sendMessage({
        type:              "metrics",
        frameIdx:          latestFrameIdxRef.current,
        audioTime:         latestAudioTimeRef.current,
        rttMs:             latestRttMsRef.current,
        serverProcMs:      latestSrvProcMsRef.current,
        reactRenderMs:     reactMs,
        echartsRenderMs:   echartsMs,
        totalRecvRenderMs: totalRecvMs,
        totalE2eMs,
      });
    }

    // 브라우저 콘솔 요약
    if (metricsCountRef.current % METRICS_INTERVAL === 0) {
      console.debug(
        `[Pipeline] RTT:${rtt?.toFixed(2) ?? "—"}ms` +
        ` | react:${reactMs}ms | echarts:${echartsMs}ms` +
        ` | recv→render:${totalRecvMs}ms | E2E:${totalE2eMs ?? "—"}ms`
      );
    }
  }, []);

  // ── 프레임 로그 엔트리 수집 ───────────────────────────────────────────────
  const handleDebugLog = useCallback((entry: DebugLogEntry) => {
    // 최신 frameIdx/audioTime 캐시
    latestFrameIdxRef.current  = entry.frameIdx;
    latestAudioTimeRef.current = entry.audioTime;
    // 직전 렌더 사이클의 render 타임을 첨부
    const m = latestRenderMetrics.current;
    // freshness lag 계산
    const audioNow     = currentTimeRef.current;
    const frameTime    = entry.audioTime;
    const freshLag     = audioNow > 0 && frameTime > 0
      ? parseFloat(((audioNow - frameTime) * 1000).toFixed(2))
      : null;
    const enriched: DebugLogEntry = {
      ...entry,
      reactRenderMs:     m.reactMs,
      echartsRenderMs:   m.echartsMs,
      totalRecvRenderMs: m.totalRecvMs,
      freshnessLagMs:    freshLag,
    };
    // 측정 모드: 제한 없이 별도 버퍼에 누적
    if (isMeasuringRef.current) {
      measureLogsRef.current.push(enriched);
    }
  }, []);

  // ── 상태 변경 ─────────────────────────────────────────────────────────────
  const handleStatusChange = useCallback((s: AppStatus) => {
    setStatus(s);
    if (s === "error") {
      setErrorMsg("WebSocket 연결에 실패했습니다. 서버가 실행 중인지 확인해주세요.");
    }
  }, []);

  // 배치 모드: 분석 완료 후(재생 전)에도 전체 곡선을 표시해야 하므로 frames 존재 시 active
  const isActive  = status === "playing" || status === "paused"
    || (analysisMode === "batch" && streamingFrames.length > 0);

  return (
    <div id="dashboard-root" className="flex flex-col min-h-screen lg:h-screen lg:overflow-hidden">
      <Header />

      {/* lg 미만: 세로 스크롤 허용 / lg 이상: 단일 뷰포트(내용이 넘치면 내부 스크롤) */}
      <main id="dashboard-main" className="flex-1 min-h-0 overflow-y-auto p-3">
        <div id="dashboard-content" className="lg:h-full w-full flex flex-col gap-3">

          {/* 좌/우 2열 메인 그리드 — lg 미만에서는 1열로 쌓이며 자연 높이 + 최소 높이 보장 */}
          <div id="dashboard-grid" className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:flex-1 lg:min-h-[600px]">

            {/* 좌측: upload-section / InputParameters / Waveform — 스택
                ┌─ 비율 조정 가이드 ──────────────────────────────────────────┐
                │ upload-section : flex-[2]   ← 작게 하려면 숫자 ↓ (예: 1)    │
                │ WaveformPlayer : flex-[3]   ← 크게 하려면 숫자 ↑ (예: 5)    │
                │ InputParameters: shrink-0   ← 자연 높이 (변경 불필요)        │
                └────────────────────────────────────────────────────────────┘ */}
            <div id="left-column" className="flex flex-col gap-3 min-h-0">
              {/* upload-section: 비율 조정 → flex-[숫자] 변경.
                  lg 미만: 고정 높이로 내부 h-full 카드가 확정 높이를 갖도록 함 */}
              <div id="upload-section" className="h-[220px] lg:h-auto lg:min-h-0 lg:flex-[2] flex flex-col gap-2">
                {/* 입력 모드 탭 + DEBUG/REC 액션 */}
                <div className="flex items-center gap-1 text-xs font-mono shrink-0">
                  {(["file", "mic"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => handleInputModeChange(m)}
                      className={cn(
                        "px-2.5 py-1 rounded border transition-all",
                        inputMode === m
                          ? "bg-brand-blue text-white border-brand-blue"
                          : "text-iron-400 border-iron-200 hover:border-iron-400"
                      )}
                    >
                      {m === "file" ? "파일" : "마이크"}
                    </button>
                  ))}
                  <div className="ml-auto flex gap-1.5">
                    <button
                      onClick={handleMeasureToggle}
                      className={`px-2 py-1 rounded border transition-all ${
                        isMeasuring
                          ? "bg-red-950 text-red-400 border-red-700 hover:bg-red-900 animate-pulse"
                          : "bg-iron-50 text-iron-400 border-iron-200 hover:border-iron-400"
                      }`}
                      title="측정 모드 — 시작/중지 및 JSON 다운로드"
                    >
                      {isMeasuring ? `■ ${measureFrameCount}fr` : "● REC"}
                    </button>
                  </div>
                </div>

                {/* 분석 모드 토글 + 배치 컨트롤 (파일 모드 전용) */}
                {inputMode === "file" && (
                  <div className="flex items-center gap-1.5 text-xs font-mono shrink-0">
                    {([
                      { key: "realtime", label: "실시간 추적" },
                      { key: "batch",    label: "분석" },
                    ] as const).map((m) => (
                      <button
                        key={m.key}
                        onClick={() => handleAnalysisModeChange(m.key)}
                        disabled={isAnalyzing}
                        className={cn(
                          "px-2.5 py-1 rounded border transition-all",
                          analysisMode === m.key
                            ? "bg-iron-800 text-white border-iron-800"
                            : "text-iron-400 border-iron-200 hover:border-iron-400",
                          isAnalyzing && "opacity-50 cursor-not-allowed",
                        )}
                      >
                        {m.label}
                      </button>
                    ))}

                    {analysisMode === "batch" && (
                      <div className="ml-auto flex items-center gap-1.5">
                        {isAnalyzing && batchProgress.total > 0 && (
                          <div
                            className="flex items-center gap-1.5"
                            title={`${batchProgress.done} / ${batchProgress.total} 프레임`}
                          >
                            <div className="relative h-1.5 w-24 overflow-hidden rounded-full bg-iron-200">
                              <div
                                className="absolute inset-y-0 left-0 rounded-full bg-brand-blue transition-[width] duration-200 ease-out"
                                style={{ width: `${Math.round((batchProgress.done / batchProgress.total) * 100)}%` }}
                              />
                            </div>
                            <span className="w-8 text-right text-iron-500 tabular-nums">
                              {Math.round((batchProgress.done / batchProgress.total) * 100)}%
                            </span>
                          </div>
                        )}
                        <button
                          onClick={handleRunBatch}
                          disabled={!audioFile || isAnalyzing}
                          className={cn(
                            "px-2.5 py-1 rounded border transition-all",
                            !audioFile || isAnalyzing
                              ? "text-iron-300 border-iron-200 cursor-not-allowed"
                              : "bg-brand-blue text-white border-brand-blue hover:bg-brand-blue-dark",
                          )}
                          title="전체 음원을 한 번에 분석하여 차트에 렌더링"
                        >
                          {isAnalyzing ? "분석 중…" : "분석 시작"}
                        </button>
                        <button
                          onClick={handleExportReference}
                          disabled={referenceFramesRef.current.length === 0}
                          className={cn(
                            "px-2 py-1 rounded border transition-all",
                            referenceFramesRef.current.length === 0
                              ? "text-iron-300 border-iron-200 cursor-not-allowed"
                              : "bg-iron-50 text-iron-500 border-iron-200 hover:border-iron-400",
                          )}
                          title="분석된 전체 output frame 시퀀스를 Reference JSON으로 저장"
                        >
                          JSON DOWNLOAD
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex-1 min-h-0 min-w-0">
                  {inputMode === "file" ? (
                    <AudioUploader
                      status={status}
                      selectedFile={audioFile}
                      onFileSelected={handleFileSelected}
                      onReset={handleReset}
                    />
                  ) : (
                    <MicrophonePlayer
                      status={status}
                      onStatusChange={handleStatusChange}
                      onFrameReceived={handleFrameReceived}
                      onStreamStart={handleStreamStart}
                      onDebugUpdate={handleDebugUpdate}
                      onDebugLog={handleDebugLog}
                      inputParams={inputParams}
                    />
                  )}
                </div>
                {errorMsg && (
                  <p id="error-message" className="error-message text-xs text-red-500 px-1 shrink-0">오류: {errorMsg}</p>
                )}
              </div>

              {/* Input Parameters card — 자연 높이 */}
              <div className="shrink-0">
                <InputParameters values={inputParams} onChange={setInputParams} />
              </div>

              {/* Waveform player — 비율 조정 → flex-[숫자] 변경.
                  lg 미만: 고정 높이(h-[260px])로 카드 % 높이 사슬을 확정시켜 겹침 방지 */}
              {inputMode === "file" && (
                <div className="h-[260px] lg:h-auto lg:min-h-0 lg:flex-[3]">
                  <WaveformPlayer
                    ref={waveformRef}
                    audioFile={audioFile}
                    status={status}
                    onTimeUpdate={(t: number) => { currentTimeRef.current = t; setCurrentTime(t); }}
                    onStatusChange={handleStatusChange}
                    onFrameReceived={handleFrameReceived}
                    onStreamStart={handleStreamStart}
                    onDebugUpdate={handleDebugUpdate}
                    onDebugLog={handleDebugLog}
                    inputParams={inputParams}
                    onDurationReady={setAudioDuration}
                    enableStreaming={analysisMode === "realtime"}
                  />
                </div>
              )}
            </div>

            {/* 우측: 온도 차트 / 익스큐션 차트 — 스택.
                lg 미만: 각 차트에 고정 높이(h-[300px])를 줘 ECharts height:100% 기준을 확정 */}
            <div id="charts-section" className="flex flex-col gap-3 min-h-0">
              <div className="h-[300px] lg:h-auto lg:min-h-0 lg:flex-1">
                <TemperatureChart
                  frames={streamingFrames}
                  currentTime={currentTime}
                  isActive={isActive}
                  streaming
                  audioDuration={audioDuration}
                  followWindow={analysisMode === "realtime"}
                  lttb={LTTB_ENABLED}
                  onReactRender={handleReactRender}
                  onEchartsRender={handleEchartsRender}
                />
              </div>
              <div className="h-[300px] lg:h-auto lg:min-h-0 lg:flex-1">
                <ExcursionChart
                  frames={streamingFrames}
                  currentTime={currentTime}
                  isActive={isActive}
                  streaming
                  audioDuration={audioDuration}
                  followWindow={analysisMode === "realtime"}
                  lttb={LTTB_ENABLED}
                />
              </div>
            </div>

          </div>

        </div>
      </main>
    </div>
  );
}
