"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CHANNELS } from "@/features/audio/lib/engine/core";
import { quantizeInterleaved } from "@/features/audio/lib/engine/utils";
import { envelopeChunkFrames } from "@/features/audio/lib/pcm-kit";
import { envelopeModeSuffix, recordPerfSample } from "@/shared/lib/iron-perf";
import type { DecodedPlayback } from "@/features/audio/lib/codec/playback-decode";
import { ChannelWaveStore, MAX_WAVE_BUCKETS } from "@/features/audio/lib/render/wave-store";
import { peekWavHeader, decodeWavRange } from "@/features/audio/lib/codec/wav-incremental";
import type { CaptureStreamEvent, CaptureStreamListener } from "@/features/audio/components/player/capture/types";

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
  sampleRate: number;
  /* peak 는 양자화 후 값이라 1.0 을 넘지 않는다 — 원본이 풀스케일을 넘었는지는 clipped* 로 본다. */
  peakL: number;
  peakR: number;
  clippedL: boolean;
  clippedR: boolean;
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
}: Options): {
  stores: PanelStores;
  getFullXRange: () => [number, number] | null;
  input: InputMeta | null;
} {
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

    /* 디코드 결과(Float32)를 그대로 넣지 않고 와이어와 같은 int16 로 양자화해서 집계한다.
     * Protected 는 encodeToInt16 → ±1 클램프를 거친 값이라, 원본 float 을 그대로 넣으면
     * passthrough 에서도 두 곡선이 어긋난다(1.0 을 넘는 소스에서 특히). 청크 폭은 커널
     * 내부 분해와 같게 잡아, 통째로 한 번 넣는 것과 버킷 경계가 어긋나지 않게 한다.
     * 파일 전체를 도는 이 시딩은 메인 스레드 동기 실행이라 여기 소요 시간이 곧 업로드
     * 직후 UI 정지 시간이다(envelope_seed 스테이지로 계측). */
    const totalFrames = Math.floor(decoded.pcm.length / CHANNELS);
    const chunkFrames = envelopeChunkFrames(CHANNELS, true, bucketSec, decoded.rate);
    const scratch = new Int16Array(chunkFrames * CHANNELS);
    let clippedMask = 0;

    const t0 = performance.now();
    for (let off = 0; off < totalFrames; off += chunkFrames) {
      const n = Math.min(chunkFrames, totalFrames - off);
      clippedMask |= quantizeInterleaved(decoded.pcm, off, n, scratch);
      const view = n === chunkFrames ? scratch : scratch.subarray(0, n * CHANNELS);
      const opts = { channels: CHANNELS, frames: n, startSec: off / decoded.rate, sampleRate: decoded.rate };
      inputL.addSamples(view, { ...opts, channel: 0 });
      inputR.addSamples(view, { ...opts, channel: 1 });
    }
    recordPerfSample(`envelope_seed${envelopeModeSuffix()}`, performance.now() - t0);
    inputL.flush();
    inputR.flush();

    setInput({
      durationSec: decoded.duration,
      sampleRate: decoded.rate,
      peakL: inputL.snapshot().peak,
      peakR: inputR.snapshot().peak,
      clippedL: (clippedMask & 1) !== 0,
      clippedR: (clippedMask & 2) !== 0,
    });
  }, [decodeReady, getDecodedPlayback, stores]);

  useEffect(() => {
    stores.protectedL.reset();
    stores.protectedR.reset();
    readyRef.current = false;
    pendingProtectedRef.current = [];
    backfillTokenRef.current += 1;
  }, [sourceFile, stores]);

  const applyProtectedEvent = useCallback((ev: ProtectedEvent) => {
    const { protectedL, protectedR } = stores;
    const samplesPerFrame = Math.floor(ev.processed.length / CHANNELS);
    const startSec = (ev.frameIndex * samplesPerFrame) / ev.sampleRate;

    protectedL.addSamples(ev.processed, { channels: CHANNELS, channel: 0, frames: samplesPerFrame, startSec, sampleRate: ev.sampleRate });
    protectedR.addSamples(ev.processed, { channels: CHANNELS, channel: 1, frames: samplesPerFrame, startSec, sampleRate: ev.sampleRate });
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

  /* 줌아웃·더블클릭 리셋이 "커밋된 창"이 아니라 세션 전체로 돌아가게 하는 기준.
   * source 모드에서는 뷰포트 구간만 커밋되므로 이걸 안 넘기면 줌아웃이 막힌다. */
  const getFullXRange = useCallback((): [number, number] | null => {
    const duration = Math.max(
      stores.inputL.snapshot().durationSec,
      stores.inputR.snapshot().durationSec,
      stores.protectedL.snapshot().durationSec,
      stores.protectedR.snapshot().durationSec,
    );
    return duration > 0 ? [0, duration] : null;
  }, [stores]);

  return { stores, getFullXRange, input };
}
