"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, Square } from "lucide-react";
import { cn, formatTime } from "@/lib/utils";
import { AppStatus, AnalysisFrame, StreamDebugInfo, DebugLogEntry } from "@/lib/types";

// ─── PCM 처리 상수 ────────────────────────────────────────────────────────────
const SAMPLE_RATE    = 44100;
const SAMPLES_PER_CH = 256;
const FRAME_BYTES    = SAMPLES_PER_CH * 2 * 2; // 256 samples × 2ch × 2 bytes = 1024

interface Props {
  audioFile: File | null;
  status: AppStatus;
  onTimeUpdate: (currentTime: number) => void;
  onStatusChange: (status: AppStatus) => void;
  /** WebSocket으로 수신된 분석 프레임 콜백 */
  onFrameReceived: (frame: AnalysisFrame) => void;
  /** 새 스트리밍 세션 시작 시 — 누적 프레임 초기화 신호 */
  onStreamStart: () => void;
  /** 디버그 메트릭 업데이트 (10fps 스로틀) */
  onDebugUpdate?: (info: Partial<StreamDebugInfo>) => void;
  /** 프레임 단위 로그 엔트리 (매 프레임 호출, 버퍼링은 호출자 책임) */
  onDebugLog?: (entry: DebugLogEntry) => void;
}

// ─── WebSocket URL 생성 (SSR 안전) ───────────────────────────────────────────
function getWsUrl(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/audio`;
}

// ─── Float32 → Int16 PCM 인터리브 변환 ───────────────────────────────────────
function encodeToInt16(ch0: Float32Array, ch1: Float32Array): Int16Array {
  const out = new Int16Array(ch0.length * 2);
  for (let i = 0; i < ch0.length; i++) {
    out[i * 2]     = Math.max(-32768, Math.min(32767, Math.round(ch0[i] * 32767)));
    out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(ch1[i] * 32767)));
  }
  return out;
}

export default function WaveformPlayer({
  audioFile,
  status,
  onTimeUpdate,
  onStatusChange,
  onFrameReceived,
  onStreamStart,
  onDebugUpdate,
  onDebugLog,
}: Props) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const wavesurferRef   = useRef<import("wavesurfer.js").default | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [isReady, setIsReady]         = useState(false);

  // ── PCM 프레임 데이터 (AudioContext 디코딩 결과) ──────────────────────────
  const pcmFramesRef      = useRef<ArrayBuffer[]>([]);
  const pcmReadyRef       = useRef(false);

  // ── WebSocket 상태 ────────────────────────────────────────────────────────
  const wsRef             = useRef<WebSocket | null>(null);
  const wsReadyRef        = useRef(false);

  // ── rAF 루프 ─────────────────────────────────────────────────────────────
  const rafRef            = useRef<number | null>(null);
  const lastSentFrameRef  = useRef(0);

  // ── 레이턴시 측정 ─────────────────────────────────────────────────────────
  // key: frameIndex, value: performance.now() 전송 시각
  const sendTimestampsRef   = useRef<Map<number, number>>(new Map());
  const framesSentRef       = useRef(0);
  const framesReceivedRef   = useRef(0);
  const rttSamplesRef       = useRef<number[]>([]); // 최근 100개
  const lastServerProcMsRef = useRef<number | null>(null);
  // rAF 전송 속도 측정
  const lastSendRateCheckRef = useRef<{ time: number; count: number }>({ time: 0, count: 0 });
  const sendRateFpsRef       = useRef<number | null>(null);
  // 디버그 UI 스로틀 (10fps)
  const lastDebugFlushRef   = useRef(0);

  // ── 디버그 메트릭 flush (스로틀 10fps) ──────────────────────────────────
  const flushDebug = useCallback((wsConnected: boolean) => {
    if (!onDebugUpdate) return;
    const now = performance.now();
    if (now - lastDebugFlushRef.current < 100) return; // 100ms 미만이면 스킵
    lastDebugFlushRef.current = now;

    const samples = rttSamplesRef.current;
    const avgRttMs = samples.length > 0
      ? parseFloat((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2))
      : null;
    const minRttMs = samples.length > 0 ? parseFloat(Math.min(...samples).toFixed(2)) : null;
    const maxRttMs = samples.length > 0 ? parseFloat(Math.max(...samples).toFixed(2)) : null;
    const latestRttMs = samples.length > 0
      ? parseFloat(samples[samples.length - 1].toFixed(2))
      : null;

    onDebugUpdate({
      wsConnected,
      framesSent:        framesSentRef.current,
      framesReceived:    framesReceivedRef.current,
      latestRttMs,
      avgRttMs,
      minRttMs,
      maxRttMs,
      serverProcessingMs: lastServerProcMsRef.current,
      sendRateFps:        sendRateFpsRef.current,
    });
  }, [onDebugUpdate]);

  // ── rAF 루프: WaveSurfer currentTime 기준으로 미전송 프레임 일괄 전송 ─────
  const startRaf = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const loop = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !wsReadyRef.current) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const wv = wavesurferRef.current;
      if (!wv) return;

      const currentFrame = Math.floor(wv.getCurrentTime() * SAMPLE_RATE / SAMPLES_PER_CH);
      const frames       = pcmFramesRef.current;
      const now          = performance.now();

      while (lastSentFrameRef.current < currentFrame && lastSentFrameRef.current < frames.length) {
        const idx = lastSentFrameRef.current;
        sendTimestampsRef.current.set(idx, performance.now());
        ws.send(frames[idx]);
        framesSentRef.current++;
        lastSentFrameRef.current++;
      }

      // 전송 속도 측정 (1초 윈도우)
      const rateCheck = lastSendRateCheckRef.current;
      if (now - rateCheck.time >= 1000) {
        sendRateFpsRef.current = parseFloat(
          ((framesSentRef.current - rateCheck.count) / ((now - rateCheck.time) / 1000)).toFixed(1)
        );
        lastSendRateCheckRef.current = { time: now, count: framesSentRef.current };
      }

      flushDebug(true);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
  }, [flushDebug]);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // ── WebSocket 정리 ────────────────────────────────────────────────────────
  const closeWs = useCallback(() => {
    stopRaf();
    const ws = wsRef.current;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
      }
      ws.close();
      wsRef.current = null;
    }
    wsReadyRef.current = false;
  }, [stopRaf]);

  // ── 파일 변경 시: WaveSurfer 재초기화 + PCM 디코딩 ──────────────────────
  useEffect(() => {
    // 이전 세션 정리
    closeWs();
    setIsReady(false);
    setCurrentTime(0);
    setDuration(0);
    pcmFramesRef.current     = [];
    pcmReadyRef.current      = false;
    lastSentFrameRef.current = 0;
    // 디버그 카운터 리셋
    sendTimestampsRef.current.clear();
    framesSentRef.current        = 0;
    framesReceivedRef.current    = 0;
    rttSamplesRef.current        = [];
    lastServerProcMsRef.current  = null;
    sendRateFpsRef.current       = null;
    lastSendRateCheckRef.current = { time: 0, count: 0 };
    onDebugUpdate?.({ wsConnected: false, framesSent: 0, framesReceived: 0,
      latestRttMs: null, avgRttMs: null, minRttMs: null, maxRttMs: null,
      serverProcessingMs: null, sendRateFps: null });

    if (!containerRef.current || !audioFile) return;

    let ws: import("wavesurfer.js").default;
    let destroyed = false;

    (async () => {
      // WaveSurfer 초기화
      const WaveSurfer = (await import("wavesurfer.js")).default;
      if (destroyed) return;

      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }

      ws = WaveSurfer.create({
        container:     containerRef.current!,
        waveColor:     "#CDD1DA",
        progressColor: "#0057B8",
        cursorColor:   "#1A73E8",
        cursorWidth:   2,
        barWidth:      2,
        barGap:        1,
        barRadius:     2,
        height:        72,
        normalize:     true,
        interact:      true,
      });

      ws.on("ready", (dur) => {
        if (destroyed) return;
        setDuration(dur);
        setIsReady(true);
        onStatusChange("ready");
      });

      ws.on("timeupdate", (time) => {
        if (destroyed) return;
        setCurrentTime(time);
        onTimeUpdate(time);
      });

      ws.on("finish", () => {
        if (destroyed) return;
        stopRaf();
        onStatusChange("paused");
      });

      const url = URL.createObjectURL(audioFile);
      ws.load(url);
      wavesurferRef.current = ws;

      // PCM 디코딩 (AudioContext — 파일 선택 직후 실행)
      try {
        const arrayBuf   = await audioFile.arrayBuffer();
        if (destroyed) return;

        const audioCtx   = new AudioContext({ sampleRate: SAMPLE_RATE });
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
        await audioCtx.close();
        if (destroyed) return;

        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = audioBuffer.numberOfChannels > 1
          ? audioBuffer.getChannelData(1)
          : audioBuffer.getChannelData(0);

        const interleaved  = encodeToInt16(ch0, ch1);
        // Int16Array.buffer는 ArrayBuffer | SharedArrayBuffer → 명시적 캐스트
        const rawBytes     = interleaved.buffer as ArrayBuffer;
        const totalFrames  = Math.floor(ch0.length / SAMPLES_PER_CH);
        const frames: ArrayBuffer[] = [];

        for (let i = 0; i < totalFrames; i++) {
          frames.push(rawBytes.slice(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
        }

        pcmFramesRef.current = frames;
        pcmReadyRef.current  = true;
        console.log(`[WaveformPlayer] PCM 디코딩 완료: ${totalFrames} 프레임`);
      } catch (err) {
        console.error("[WaveformPlayer] PCM 디코딩 실패:", err);
      }
    })();

    return () => {
      destroyed = true;
      ws?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFile]);

  // ── WebSocket 연결 + 스트리밍 시작 ───────────────────────────────────────
  const openWsAndStream = useCallback(() => {
    // 이미 연결 중이면 재사용
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && wsReadyRef.current) {
      startRaf();
      return;
    }

    // 이전 연결 정리
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    lastSentFrameRef.current = 0;
    wsReadyRef.current = false;
    onStreamStart(); // 누적 프레임 초기화 신호

    const wsUrl = getWsUrl();
    if (!wsUrl) return;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "init" }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "ready") {
        wsReadyRef.current = true;
        startRaf();
      } else if (msg.type === "frame") {
        // ── RTT 계산 ──────────────────────────────────────────────────────
        const recvAt    = performance.now();
        const frameIdx  = Math.round((msg.time as number) * SAMPLE_RATE / SAMPLES_PER_CH);
        const sentAt    = sendTimestampsRef.current.get(frameIdx);
        if (sentAt !== undefined) {
          const rtt = parseFloat((recvAt - sentAt).toFixed(2));
          const samples = rttSamplesRef.current;
          samples.push(rtt);
          if (samples.length > 100) samples.shift();
          sendTimestampsRef.current.delete(frameIdx);

          // 콘솔 로그 (매 50프레임마다 출력)
          if (framesReceivedRef.current % 50 === 0) {
            const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
            console.debug(
              `[Latency] frame#${frameIdx} | RTT: ${rtt}ms | avg: ${avg.toFixed(2)}ms | server: ${msg.processingMs}ms`
            );
          }
        }
        lastServerProcMsRef.current = msg.processingMs as number;
        framesReceivedRef.current++;

        // 로그 엔트리 생성
        onDebugLog?.({
          receivedAt:   recvAt,
          audioTime:    msg.time        as number,
          frameIdx,
          rttMs:        sentAt !== undefined
            ? parseFloat((recvAt - sentAt).toFixed(2))
            : null,
          serverProcMs: msg.processingMs as number,
          temperature:  msg.temperature  as number,
          excursion:    msg.excursion    as number,
        });

        onFrameReceived({
          time:        msg.time        as number,
          temperature: msg.temperature as number,
          excursion:   msg.excursion   as number,
        });

        flushDebug(true);
      } else if (msg.type === "error") {
        console.error("[WaveformPlayer] WS 서버 오류:", msg.message);
        onStatusChange("error");
      }
    };

    ws.onerror = () => {
      console.error("[WaveformPlayer] WebSocket 연결 오류");
      onStatusChange("error");
    };

    ws.onclose = () => {
      wsReadyRef.current = false;
      onDebugUpdate?.({ wsConnected: false });
    };
  }, [startRaf, onStreamStart, onFrameReceived, onStatusChange]);

  // ── 재생/일시정지 ─────────────────────────────────────────────────────────
  const handlePlayPause = useCallback(() => {
    if (!wavesurferRef.current || !isReady) return;

    if (wavesurferRef.current.isPlaying()) {
      // 일시정지
      wavesurferRef.current.pause();
      stopRaf();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "pause" }));
      }
      onStatusChange("paused");
    } else {
      // 재생
      wavesurferRef.current.play();
      onStatusChange("playing");
      openWsAndStream();
    }
  }, [isReady, stopRaf, openWsAndStream, onStatusChange]);

  // ── 정지 ─────────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    if (!wavesurferRef.current) return;
    wavesurferRef.current.stop();
    setCurrentTime(0);
    closeWs();
    lastSentFrameRef.current = 0;
    onStatusChange("ready");
  }, [closeWs, onStatusChange]);

  const isPlaying = status === "playing";
  const progress  = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div id="waveform-player" className="card">
      <div className="card-header">
        <span className="card-title">Waveform</span>
        {isReady && (
          <span id="waveform-time-display" className="font-mono text-xs text-iron-400">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        )}
      </div>

      <div className="waveform-body p-4 space-y-4">
        {/* WaveSurfer 캔버스 */}
        <div
          id="waveform-canvas"
          ref={containerRef}
          className={cn(
            "w-full rounded-lg bg-iron-50 overflow-hidden",
            !audioFile && "flex items-center justify-center h-[72px]"
          )}
        >
          {!audioFile && (
            <p className="waveform-placeholder text-xs text-iron-400">파일을 업로드하면 파형이 표시됩니다</p>
          )}
        </div>

        {/* 진행 바 */}
        {isReady && (
          <div id="playback-progress-track" className="h-1 bg-iron-100 rounded-full overflow-hidden">
            <div
              id="playback-progress-fill"
              className="h-full bg-brand-blue transition-all duration-100"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* 재생 컨트롤 */}
        <div id="player-controls" className="flex items-center gap-2">
          <button
            id="play-pause-btn"
            onClick={handlePlayPause}
            disabled={!isReady}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
              isReady
                ? "bg-brand-blue text-white hover:bg-brand-blue-dark"
                : "bg-iron-100 text-iron-300 cursor-not-allowed"
            )}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {isPlaying ? "Pause" : "Play"}
          </button>

          <button
            id="stop-btn"
            onClick={handleStop}
            disabled={!isReady}
            className={cn(
              "p-2 rounded-lg transition-all",
              isReady
                ? "text-iron-500 hover:bg-iron-100 hover:text-iron-700"
                : "text-iron-300 cursor-not-allowed"
            )}
          >
            <Square size={14} />
          </button>

          {/* 스트리밍 연결 상태 표시 */}
          {isReady && (
            <span className="ml-auto text-xs text-iron-400 flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-block w-1.5 h-1.5 rounded-full",
                  isPlaying ? "bg-green-400 animate-pulse" : "bg-iron-300"
                )}
              />
              {isPlaying ? "스트리밍 중" : "대기"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
