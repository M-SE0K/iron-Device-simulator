"use client";

// PCM 디코딩 파이프라인(WaveformPlayer 전용) — 오디오 파일을 세션 설정(sampleRate/samplesPerCh)에
// 맞춰 프레임(기본 1920바이트) 배열로 잘라둔다. useAnalysisStream의 rAF 전송 루프가 그대로 소비한다.
import { useEffect, useRef, useState } from "react";
import { DEFAULT_ENGINE_CONFIG, frameBytes, type EngineRuntimeConfig } from "@/features/audio/lib/engine/core";
import { encodeToInt16 } from "@/features/audio/lib/engine/utils";

export function usePcmDecoder(audioFile: File | null, sampleRate: string, bufferSize: string) {
  const pcmFramesRef    = useRef<ArrayBuffer[]>([]);
  const pcmReadyRef     = useRef(false);
  const engineConfigRef = useRef<EngineRuntimeConfig>(DEFAULT_ENGINE_CONFIG);
  const [displayConfig, setDisplayConfig] = useState<EngineRuntimeConfig | null>(null);

  useEffect(() => {
    pcmFramesRef.current = [];
    pcmReadyRef.current  = false;
    setDisplayConfig(null);

    if (!audioFile) return;

    let cancelled = false;

    (async () => {
      try {
        // 디코딩 시작 시점의 calibration 값으로 이번 세션의 프레임 설정을 고정한다
        // (비동기 디코딩 도중 calibration이 또 바뀌어도 이미 만든 프레임과 어긋나지 않게).
        const reqSampleRate   = Number(sampleRate) || DEFAULT_ENGINE_CONFIG.sampleRate;
        const reqSamplesPerCh = Number(bufferSize) || DEFAULT_ENGINE_CONFIG.samplesPerCh;
        const config: EngineRuntimeConfig = { sampleRate: reqSampleRate, samplesPerCh: reqSamplesPerCh };
        engineConfigRef.current = config;
        setDisplayConfig(config);

        const arrayBuf = await audioFile.arrayBuffer();
        if (cancelled) return;

        const audioCtx    = new AudioContext({ sampleRate: reqSampleRate });
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
        await audioCtx.close();
        if (cancelled) return;

        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = audioBuffer.numberOfChannels > 1
          ? audioBuffer.getChannelData(1)
          : audioBuffer.getChannelData(0);

        const interleaved = encodeToInt16(ch0, ch1);
        // Int16Array.buffer는 ArrayBuffer | SharedArrayBuffer → 명시적 캐스트
        const rawBytes    = interleaved.buffer as ArrayBuffer;
        const chunkBytes  = frameBytes(config);
        const totalFrames = Math.floor(ch0.length / reqSamplesPerCh);
        const frames: ArrayBuffer[] = [];

        for (let i = 0; i < totalFrames; i++) {
          frames.push(rawBytes.slice(i * chunkBytes, (i + 1) * chunkBytes));
        }

        pcmFramesRef.current = frames;
        pcmReadyRef.current  = true;
        console.log(`[usePcmDecoder] PCM 디코딩 완료: ${totalFrames} 프레임 (${reqSampleRate}Hz, ${reqSamplesPerCh}samples/ch)`);
      } catch (err) {
        console.error("[usePcmDecoder] PCM 디코딩 실패:", err);
      }
    })();

    return () => { cancelled = true; };
  }, [audioFile, sampleRate, bufferSize]);

  return { pcmFramesRef, pcmReadyRef, engineConfigRef, displayConfig };
}
