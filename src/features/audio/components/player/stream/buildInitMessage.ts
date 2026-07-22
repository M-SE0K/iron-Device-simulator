import type { InputParameterValues } from "@/features/audio/types";
import type { EngineRuntimeConfig } from "@/features/audio/lib/engine/core";

export function buildInitMessage(inputParams: InputParameterValues | undefined, config: EngineRuntimeConfig): string {
  return JSON.stringify({
    type:           "init",
    ampOutputPower: inputParams?.ampOutputPower ?? "",
    speakerModel:   inputParams?.speakerModel   ?? "",
    ambientTemp:    inputParams?.ambientTemp    ?? "",
    sampleRate:     config.sampleRate,
    bufferSize:     config.samplesPerCh,
  });
}
