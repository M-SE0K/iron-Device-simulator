/**
 * mock-engine.ts — Mock 분석 모델
 *
 * libirontune.so 없이(USE_MOCK=true) 온도·익스커션을 시뮬레이션하는 mockFrame.
 * 스피커 프로파일 / 전력 스케일은 engine-core(공통)에서 가져온다.
 */

import type { EngineParams } from "../types";
import { SPEAKER_PROFILES, DEFAULT_PROFILE, powerTempMult } from "./engine-core";

// ─── Mock 온도·익스커션 생성 (재생 시간 + 엔진 파라미터 기반) ───────────────
export function mockFrame(
  time: number,
  params: EngineParams,
): { temperature: [number, number]; excursion: [number, number] } {
  const profile  = SPEAKER_PROFILES[params.speakerModel] ?? DEFAULT_PROFILE;
  const pwrScale = powerTempMult(params.ampOutputPower);

  // 온도 ch0 (L) — 기준 모델 곡선
  const tempRise = 15 * profile.tempMult * pwrScale;
  const temp0 = parseFloat(
    (profile.tempBase * pwrScale + tempRise * Math.sin((time / 30) * Math.PI)
      + (Math.random() - 0.5) * 3).toFixed(2)
  );
  // 온도 ch1 (R) — 방열 환경 차이: 기준보다 약 8°C 높고 느리게 상승
  const temp1 = parseFloat(
    (profile.tempBase * pwrScale * 1.12 + tempRise * 0.85 * Math.sin((time / 38) * Math.PI)
      + (Math.random() - 0.5) * 3).toFixed(2)
  );

  // 익스커션 ch0 (L)
  const exc0 = parseFloat(
    (profile.excAmp * profile.excMult
      * Math.sin((time * 2 * Math.PI) / 0.8)
      * (0.7 + 0.3 * Math.sin(time * 0.4))
      + (Math.random() - 0.5) * 0.5).toFixed(3)
  );
  // 익스커션 ch1 (R) — 진폭 ×0.7, 위상 π/2 (90°) 차이로 명확히 구분
  const exc1 = parseFloat(
    (profile.excAmp * profile.excMult * 0.7
      * Math.sin((time * 2 * Math.PI) / 0.8 + Math.PI / 2)
      * (0.7 + 0.3 * Math.sin(time * 0.4 + 0.5))
      + (Math.random() - 0.5) * 0.5).toFixed(3)
  );
  return { temperature: [temp0, temp1], excursion: [exc0, exc1] };
}
