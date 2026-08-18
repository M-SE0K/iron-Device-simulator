"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { envelopeModeSuffix, recordPerfSample } from "@/shared/lib/iron-perf";
import { yieldToMain } from "@/shared/lib/yield-to-main";
import type {
  CaptureSnapshot,
  CaptureStreamEvent,
  CaptureStreamListener,
} from "@/features/audio/components/player/capture/types";
import { ChannelWaveStore } from "@/features/audio/lib/render/wave-store";

const SLICE_BUDGET_MS = 4;

/* 백필에서 한 번에 집계로 넘기는 와이어 프레임 런 크기 — pcm-kit 커널이 벌크로
 * 처리하므로 프레임 단위 대신 런 단위(기본 480샘플 × 128 ≈ 1.3초 분량)로 배치한다. */
const BACKFILL_RUN_FRAMES = 128;

export interface ChannelStreamHeader {
  channels: number;
  sampleRate: number;
}

interface Options {
  wantedChannels: number[];
  listen: boolean;
  probe: boolean;
  getChannelsSnapshot?: () => CaptureSnapshot | null;
  subscribeChannelStream?: (fn: CaptureStreamListener) => () => void;
}

export function useChannelWaveStreams({
  wantedChannels,
  listen,
  probe,
  getChannelsSnapshot,
  subscribeChannelStream,
}: Options) {
  const [header, setHeader] = useState<ChannelStreamHeader | null>(null);

  const storesRef = useRef<Map<number, ChannelWaveStore>>(new Map());
  const getStore = useCallback((ch: number): ChannelWaveStore => {
    let waveStore = storesRef.current.get(ch);
    if (!waveStore) {
      waveStore = new ChannelWaveStore();
      storesRef.current.set(ch, waveStore);
    }
    return waveStore;
  }, []);

  const wantedChannelsRef = useRef<number[]>(wantedChannels);
  useEffect(() => { wantedChannelsRef.current = wantedChannels; }, [wantedChannels]);
  const totalFramesRef = useRef(0);
  const seededRef = useRef<Set<number>>(new Set());
  const sessionTokenRef = useRef(0);

  useEffect(() => {
    const wantedSet = new Set(wantedChannels);
    for (const ch of seededRef.current) {
      if (!wantedSet.has(ch)) seededRef.current.delete(ch);
    }
    for (const ch of storesRef.current.keys()) {
      if (!wantedSet.has(ch)) storesRef.current.delete(ch);
    }
  }, [wantedChannels]);

  const handleChunk = useCallback((chunk: Int16Array, channels: number, sampleRate: number) => {
    const frameCount = Math.floor(chunk.length / channels);
    if (frameCount === 0) return;
    const startSec = totalFramesRef.current / sampleRate;
    totalFramesRef.current += frameCount;
    setHeader((prev) => (
      prev && prev.channels === channels && prev.sampleRate === sampleRate
        ? prev
        : { channels, sampleRate }
    ));

    const wanted = wantedChannelsRef.current;
    if (wanted.length === 0) return;

    for (const ch of wanted) {
      if (ch >= channels) continue;
      const waveStore = getStore(ch);
      waveStore.addSamples(chunk, { channels, channel: ch, frames: frameCount, startSec, sampleRate });
      waveStore.flush();
    }
  }, [getStore]);

  const handleStreamEvent = useCallback((ev: CaptureStreamEvent) => {
    if (ev.type === "reset") {
      sessionTokenRef.current += 1;
      totalFramesRef.current = 0;
      seededRef.current.clear();
      storesRef.current.forEach((waveStore) => waveStore.reset());
      setHeader({ channels: ev.channels, sampleRate: ev.sampleRate });
      return;
    }
    if (ev.type !== "chunk") return;
    handleChunk(ev.chunk, ev.channels, ev.sampleRate);
  }, [handleChunk]);

  useEffect(() => {
    if (!subscribeChannelStream || !listen) return;
    return subscribeChannelStream(handleStreamEvent);
  }, [subscribeChannelStream, listen, handleStreamEvent]);

  useEffect(() => {
    if (!probe || !getChannelsSnapshot) return;
    const snap = getChannelsSnapshot();
    if (!snap) return;
    if (totalFramesRef.current === 0) totalFramesRef.current = snap.totalFrames;
    setHeader((prev) => (
      prev && prev.channels === snap.channels && prev.sampleRate === snap.sampleRate
        ? prev
        : { channels: snap.channels, sampleRate: snap.sampleRate }
    ));
  }, [probe, getChannelsSnapshot]);

  useEffect(() => {
    const batch = wantedChannels.filter((ch) => !seededRef.current.has(ch));
    if (batch.length === 0 || !getChannelsSnapshot) return;
    batch.forEach((ch) => seededRef.current.add(ch));

    const token = sessionTokenRef.current;
    const targets = batch.map((ch) => [ch, getStore(ch)] as const);
    const stale = () =>
      sessionTokenRef.current !== token
      || targets.some(([ch, s]) => storesRef.current.get(ch) !== s);

    (async () => {
      const snap = getChannelsSnapshot();
      if (!snap) return;
      const { channels, sampleRate, samplesPerFrame, pcm } = snap;
      const liveTargets = targets.filter(([ch]) => ch < channels);
      if (liveTargets.length === 0) return;

      const frameCount = Math.floor(snap.totalFrames / samplesPerFrame);
      let busyMs = 0;
      let sliceStart = performance.now();
      let deadline = sliceStart + SLICE_BUDGET_MS;

      let fi = 0;
      while (fi < frameCount) {
        const run = pcm.frameRun(fi, Math.min(BACKFILL_RUN_FRAMES, frameCount - fi));
        if (run.frames === 0) break;
        const startSec = (fi * samplesPerFrame) / sampleRate;
        const audioFrames = run.frames * samplesPerFrame;
        for (const [ch, waveStore] of liveTargets) {
          waveStore.addSamples(run.view, { channels, channel: ch, frames: audioFrames, startSec, sampleRate });
        }
        fi += run.frames;
        if (performance.now() >= deadline) {
          liveTargets.forEach(([, s]) => s.flush());
          busyMs += performance.now() - sliceStart;
          await yieldToMain();
          if (stale()) return;
          sliceStart = performance.now();
          deadline = sliceStart + SLICE_BUDGET_MS;
        }
      }
      liveTargets.forEach(([, s]) => s.flush());
      busyMs += performance.now() - sliceStart;
      recordPerfSample(`envelope_backfill${envelopeModeSuffix()}`, busyMs);

      if (sessionTokenRef.current !== token) return;
      setHeader((prev) => (
        prev && prev.channels === channels && prev.sampleRate === sampleRate
          ? prev
          : { channels, sampleRate }
      ));
    })();
  }, [wantedChannels, getChannelsSnapshot, getStore]);

  return { header, getStore };
}
