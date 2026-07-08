"use client";

// 배치 분석 파이프라인(WaveformPlayer 전용) — 디코딩된 PCM 전체를 재생 동기화 없이 별도 소켓으로
// 한 번에 흘려보내 전체 curve를 만든다. 백프레셔(버퍼 상한)만 고려해 순차 전송한다.
import { useCallback, type MutableRefObject } from "react";
import type { AnalysisFrame, InputParameterValues } from "@/features/audio/types";
import { createAnalysisSocket } from "@/features/audio/lib/engine/protocol/local-socket";
import type { EngineRuntimeConfig } from "@/features/audio/lib/engine/core";
import { buildInitMessage } from "./buildInitMessage";

export interface UseBatchAnalysisDeps {
  pcmFramesRef: MutableRefObject<ArrayBuffer[]>;
  pcmReadyRef: MutableRefObject<boolean>;
  engineConfigRef: MutableRefObject<EngineRuntimeConfig>;
  inputParamsRef: MutableRefObject<InputParameterValues | undefined>;
}

export function useBatchAnalysis(deps: UseBatchAnalysisDeps) {
  const { pcmFramesRef, pcmReadyRef, engineConfigRef, inputParamsRef } = deps;

  const runBatchAnalysis = useCallback(
    (onProgress?: (done: number, total: number) => void): Promise<AnalysisFrame[]> => {
      return new Promise<AnalysisFrame[]>((resolve, reject) => {
        if (!pcmReadyRef.current || pcmFramesRef.current.length === 0) {
          reject(new Error("PCM 디코딩이 아직 완료되지 않았습니다."));
          return;
        }

        const frames       = pcmFramesRef.current;
        const totalFrames  = frames.length;
        // frameIdx → AnalysisFrame (수신 순서로 time을 매기므로 idx로 정렬)
        const collected    = new Map<number, AnalysisFrame>();

        const batchWs = createAnalysisSocket();
        let settled = false;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          try { batchWs.close(); } catch { /* noop */ }
          fn();
        };

        // 백프레셔를 고려해 프레임을 순차 전송 (버퍼 과적 방지)
        const BUFFER_LIMIT = 4 * 1024 * 1024; // 4MB
        const sendAll = () => {
          let i = 0;
          const pump = () => {
            if (settled) return;
            while (i < totalFrames) {
              if (batchWs.bufferedAmount > BUFFER_LIMIT) {
                setTimeout(pump, 4);
                return;
              }
              batchWs.send(frames[i]);
              i++;
            }
          };
          pump();
        };

        batchWs.onopen = () => {
          batchWs.send(buildInitMessage(inputParamsRef.current, engineConfigRef.current));
        };

        batchWs.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "ready") {
            sendAll();
          } else if (msg.type === "frame") {
            const { sampleRate, samplesPerCh } = engineConfigRef.current;
            const frameIdx = Math.round((msg.time as number) * sampleRate / samplesPerCh);
            collected.set(frameIdx, {
              time:        msg.time      as number,
              temperature: msg.temperature as [number, number],
              excursion:   msg.excursion   as [number, number],
            });
            if (onProgress && collected.size % 50 === 0) onProgress(collected.size, totalFrames);

            if (collected.size >= totalFrames) {
              onProgress?.(totalFrames, totalFrames);
              const ordered = Array.from(collected.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([, f]) => f);
              finish(() => resolve(ordered));
            }
          } else if (msg.type === "error") {
            finish(() => reject(new Error(msg.message ?? "WASM 분석 오류")));
          }
        };

        batchWs.onerror = () => finish(() => reject(new Error("WebSocket 연결 오류")));
        batchWs.onclose = () => {
          // 모든 프레임 수신 전에 닫히면 부분 결과로 종료
          if (!settled) {
            const ordered = Array.from(collected.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([, f]) => f);
            if (ordered.length > 0) finish(() => resolve(ordered));
            else finish(() => reject(new Error("분석 결과를 받지 못했습니다.")));
          }
        };
      });
    },
    [pcmFramesRef, pcmReadyRef, engineConfigRef, inputParamsRef],
  );

  return { runBatchAnalysis };
}
