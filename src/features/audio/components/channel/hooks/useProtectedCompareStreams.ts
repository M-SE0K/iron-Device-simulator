"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CHANNELS } from "@/features/audio/lib/engine/core";
import { copyChannelFloat32, readChannelFloat32 } from "@/features/audio/lib/pcm";
import type { DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";
import { ChannelWaveStore, MAX_WAVE_BUCKETS } from "@/features/audio/lib/render/wave-store";
import { peekWavHeader, decodeWavRange } from "@/features/audio/lib/codec/wav-incremental";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/types";

const EXTRACT_CHUNK_FRAMES = 131072;

const TARGET_BUCKET_SEC = 0.001;
const MAX_BUCKETS = Math.floor(MAX_WAVE_BUCKETS * 0.99);

function bucketSecFor(durationSec: number): number {
  if (!(durationSec > 0)) return TARGET_BUCKET_SEC;
  const buckets = Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(durationSec / TARGET_BUCKET_SEC)));
  return durationSec / buckets;
}

export interface PanelStores {
  inputL: ChannelWaveStore;
  inputR: ChannelWaveStore;
  protectedL: ChannelWaveStore;
  protectedR: ChannelWaveStore;
}

export interface InputMeta {
  durationSec: number;
  peakL: number;
  peakR: number;
}

interface Options {
  subscribeCaptureStream: (fn: CaptureStreamListener) => () => void;
  sourceFile?: File | null;
  getDecodedPlayback?: () => DecodedPlayback | null;
  decodeReady?: boolean;
  getProtectedBlob?: () => Blob | null;
}

export function useProtectedCompareStreams({
  subscribeCaptureStream,
  sourceFile,
  getDecodedPlayback,
  decodeReady = false,
  getProtectedBlob,
}: Options): { stores: PanelStores; input: InputMeta | null } {
  const [input, setInput] = useState<InputMeta | null>(null);

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

  type ProtectedEvent = Extract<CaptureStreamEvent, { type: "protected" }>;
  const pendingProtectedRef = useRef<ProtectedEvent[]>([]);
  const readyRef = useRef(false);
  const backfillTokenRef = useRef(0);

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

  const protectedScratchRef = useRef<{ l: Float32Array; r: Float32Array } | null>(null);

  const applyProtectedEvent = useCallback((ev: ProtectedEvent) => {
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

  return { stores, input };
}
