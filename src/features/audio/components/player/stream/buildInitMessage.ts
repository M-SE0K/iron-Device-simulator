// 분석 소켓 "init" 메시지 빌더 — 실시간 스트림(useAnalysisStream)과 배치 분석(useBatchAnalysis)이 공유한다.
import type { InputParameterValues } from "@/features/audio/types";
import type { EngineRuntimeConfig } from "@/features/audio/lib/engine/core";

export function buildInitMessage(inputParams: InputParameterValues | undefined, config: EngineRuntimeConfig): string {
  return JSON.stringify({
    type:           "init",
    ampOutputPower: inputParams?.ampOutputPower ?? "",
    speakerModel:   inputParams?.speakerModel   ?? "",
    sampleRate:     config.sampleRate,
    bufferSize:     config.samplesPerCh,
  });
}
