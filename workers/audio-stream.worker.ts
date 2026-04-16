/// <reference lib="webworker" />

import type { WsServerMessage } from "../lib/types";
import type {
  MainToWorkerMessage,
  WorkerInitPayload,
  WorkerToMainMessage,
} from "../lib/worker-types";

declare const self: DedicatedWorkerGlobalScope;

let ws: WebSocket | null = null;
let initPayload: WorkerInitPayload | null = null;

let pcmBuffer: ArrayBuffer | null = null;
let sampleRate = 44100;
let samplesPerCh = 256;
let frameBytes = 1024;
let totalFrames = 0;

let connected = false;
let ready = false;
let playing = false;
let loopTimer: number | null = null;

let lastSentFrame = 0;
let playbackBasePerfMs = 0;
let playbackBaseOffsetSec = 0;

let framesSent = 0;
let framesReceived = 0;
let sendRateFps: number | null = null;
let lastRateCheck = { time: 0, count: 0 };
let lastStatsFlushAt = 0;

let latestRttMs: number | null = null;
let rttSumMs = 0;
let rttCount = 0;
let minRttMs: number | null = null;
let maxRttMs: number | null = null;
let serverProcessingMs: number | null = null;

const sendTimes = new Map<number, number>();

function post(message: WorkerToMainMessage): void {
  self.postMessage(message);
}

function stopLoop(): void {
  if (loopTimer !== null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function flushStats(force = false): void {
  const now = performance.now();
  if (!force && now - lastStatsFlushAt < 100) return;
  lastStatsFlushAt = now;
  const avgRttMs = rttCount > 0 ? parseFloat((rttSumMs / rttCount).toFixed(2)) : null;
  post({
    type: "stats",
    connected,
    ready,
    framesSent,
    framesReceived,
    sendRateFps,
    latestRttMs,
    avgRttMs,
    minRttMs,
    maxRttMs,
    serverProcessingMs,
  });
}

function resetPlaybackCounters(): void {
  lastSentFrame = 0;
  framesSent = 0;
  framesReceived = 0;
  sendRateFps = null;
  lastRateCheck = { time: 0, count: 0 };
  latestRttMs = null;
  rttSumMs = 0;
  rttCount = 0;
  minRttMs = null;
  maxRttMs = null;
  serverProcessingMs = null;
  sendTimes.clear();
}

function maybeStartLoop(): void {
  if (loopTimer !== null || !playing || !ready || !ws || ws.readyState !== WebSocket.OPEN || !pcmBuffer) {
    return;
  }

  const tick = (): void => {
    loopTimer = null;

    if (!playing || !ready || !ws || ws.readyState !== WebSocket.OPEN || !pcmBuffer) {
      return;
    }

    const now = performance.now();
    const elapsedSec = (now - playbackBasePerfMs) / 1000;
    const targetFrame = Math.floor(
      ((playbackBaseOffsetSec + elapsedSec) * sampleRate) / samplesPerCh
    );

    while (lastSentFrame < targetFrame && lastSentFrame < totalFrames) {
      if (ws.bufferedAmount > frameBytes * 8) break;

      const start = lastSentFrame * frameBytes;
      const end = start + frameBytes;
      sendTimes.set(lastSentFrame, performance.now());
      ws.send(pcmBuffer.slice(start, end));
      framesSent++;
      lastSentFrame++;
    }

    if (lastRateCheck.time === 0) {
      lastRateCheck = { time: now, count: framesSent };
    } else if (now - lastRateCheck.time >= 1000) {
      sendRateFps = parseFloat(
        ((framesSent - lastRateCheck.count) / ((now - lastRateCheck.time) / 1000)).toFixed(1)
      );
      lastRateCheck = { time: now, count: framesSent };
    }

    flushStats();

    if (playing && lastSentFrame < totalFrames) {
      loopTimer = self.setTimeout(tick, 4) as unknown as number;
    }
  };

  loopTimer = self.setTimeout(tick, 0) as unknown as number;
}

function connectWs(wsUrl: string, nextInitPayload: WorkerInitPayload): void {
  initPayload = nextInitPayload;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    connected = true;
    ready = false;
    ws?.send(JSON.stringify({ type: "init", ...initPayload }));
    flushStats(true);
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;

    let msg: WsServerMessage;
    try {
      msg = JSON.parse(event.data) as WsServerMessage;
    } catch {
      return;
    }

    if (msg.type === "ready") {
      ready = true;
      post({ type: "ready" });
      flushStats(true);
      maybeStartLoop();
      return;
    }

    if (msg.type === "frame") {
      const receivedAt = performance.now();
      // 서버 응답에 frameIdx가 없으므로 time에서 역산
      const frameIdx = Math.round(msg.time * sampleRate / samplesPerCh);
      const sentAt = sendTimes.get(frameIdx);
      const rttMs = sentAt !== undefined
        ? parseFloat((receivedAt - sentAt).toFixed(2))
        : null;

      if (sentAt !== undefined) sendTimes.delete(frameIdx);
      // publish skip으로 응답이 없는 이전 frameIdx의 sendTimes를 정리 (메모리 상한)
      if (sendTimes.size > 64) {
        for (const k of sendTimes.keys()) {
          if (k < frameIdx) sendTimes.delete(k);
        }
      }

      if (rttMs !== null) {
        latestRttMs = rttMs;
        rttSumMs += rttMs;
        rttCount++;
        minRttMs = minRttMs === null ? rttMs : Math.min(minRttMs, rttMs);
        maxRttMs = maxRttMs === null ? rttMs : Math.max(maxRttMs, rttMs);
      }
      serverProcessingMs = msg.processingMs;
      framesReceived++;

      post({
        type: "frame",
        frameIdx,
        time: msg.time,
        temperature: msg.temperature,
        excursion: msg.excursion,
        processingMs: msg.processingMs,
        rttMs,
        receivedAt,
      });

      flushStats();
      return;
    }

    if (msg.type === "error") {
      post({ type: "error", message: msg.message });
    }
  };

  ws.onerror = () => {
    post({ type: "error", message: "Worker WebSocket 연결 오류" });
  };

  ws.onclose = () => {
    connected = false;
    ready = false;
    stopLoop();
    flushStats(true);
    post({ type: "closed" });
  };
}

function stopAndCloseSocket(): void {
  playing = false;
  stopLoop();
  ready = false;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }

  ws = null;
  connected = false;
  flushStats(true);
}

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "connect":
      connectWs(msg.wsUrl, msg.initPayload);
      break;

    case "init-file":
      pcmBuffer = msg.pcmBuffer;
      sampleRate = msg.sampleRate;
      samplesPerCh = msg.samplesPerCh;
      frameBytes = msg.frameBytes;
      totalFrames = msg.totalFrames;
      resetPlaybackCounters();
      maybeStartLoop();
      break;

    case "play": {
      playing = true;
      playbackBasePerfMs = msg.playbackBasePerfMs;
      playbackBaseOffsetSec = msg.startOffsetSec;
      const desiredFrame = Math.floor((msg.startOffsetSec * sampleRate) / samplesPerCh);
      if (desiredFrame > lastSentFrame) {
        lastSentFrame = desiredFrame;
      }
      maybeStartLoop();
      break;
    }

    case "pause":
      playing = false;
      playbackBaseOffsetSec = msg.pausedAtSec;
      stopLoop();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pause" }));
      }
      break;

    case "stop":
      resetPlaybackCounters();
      stopAndCloseSocket();
      break;

    case "sync-clock": {
      playbackBaseOffsetSec = msg.currentTimeSec;
      playbackBasePerfMs = msg.performanceNowMs;
      const desiredFrame = Math.floor((msg.currentTimeSec * sampleRate) / samplesPerCh);
      if (desiredFrame > lastSentFrame + 2) {
        lastSentFrame = desiredFrame;
      }
      if (playing) maybeStartLoop();
      break;
    }

    case "send-json":
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg.message));
      }
      break;

    case "mic-frame":
      if (ws?.readyState === WebSocket.OPEN && ready) {
        // 서버는 수신한 바이너리 프레임마다 frameIdx를 0부터 증가시키므로
        // 현재 framesSent 값이 곧 다음 프레임의 frameIdx다.
        sendTimes.set(framesSent, performance.now());
        ws.send(msg.buffer);
        framesSent++;
        flushStats();
      }
      break;
  }
};

export {};
