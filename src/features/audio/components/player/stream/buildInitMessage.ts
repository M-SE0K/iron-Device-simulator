// 분석 소켓 "init" 메시지 빌더 — 캡처 세션(useCaptureSession)이 마이크/파일 두 입력 모드 공용으로 쓴다.
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
