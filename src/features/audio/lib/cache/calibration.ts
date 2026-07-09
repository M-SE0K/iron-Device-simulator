// ── 캘리브레이션 파라미터 sessionStorage 캐시 ────────────────────────────────
// CalibrationDrawer "적용" 시 Context에 커밋된 값을 새로고침(F5)에도 유지한다.
//   · 수명: 탭이 살아있는 동안(새로고침 포함, lib/cache/frame.ts와 동일 정책). 탭을 닫으면 사라진다.
//   · CalibrationValues 필드가 늘어나도 깨지지 않도록 Partial로 불러와 기본값과 병합해서 쓴다.
import type { CalibrationValues } from "@/features/audio/components/calibration/CalibrationContext";

const KEY = "irondevice:calibration:v1";

export function saveCalibrationCache(values: CalibrationValues): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(values));
  } catch {
    // 용량 초과 등 — 캘리브레이션 값은 작으므로 조용히 포기해도 무방
  }
}

export function loadCalibrationCache(): Partial<CalibrationValues> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Partial<CalibrationValues>;
  } catch {
    return null;
  }
}

// ── 캡처 probe로 확인한 "실제 적용 런타임 값" sessionStorage 캐시 ─────────────
// BufferFrameSize는 per-client(TN2321)라 query()로는 장치 기본값만 보인다. "적용" 시 capture(IOProc)를 잠깐 열었다 닫아 얻은 실제 반영값(actual)을 여기 저장해, 새로고침(F5) 후에도 "연결된 장치" 패널에서 마지막으로 적용된 런타임 버퍼/샘플레이트를 확인할 수 있게 한다.
//   · 수명: 탭이 살아있는 동안(새로고침 포함). 탭을 닫으면 사라진다.
const DEVICE_ACTUAL_KEY = "irondevice:device-actual:v1";

export interface DeviceActualCache {
  requested: { sampleRate: number; bufferSize: number };
  actual: { sampleRate: number | null; bufferSize: number | null };
}

export function saveDeviceActualCache(v: DeviceActualCache): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DEVICE_ACTUAL_KEY, JSON.stringify(v));
  } catch {
    /* 무시 */
  }
}

export function loadDeviceActualCache(): DeviceActualCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(DEVICE_ACTUAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.actual) return null;
    return parsed as DeviceActualCache;
  } catch {
    return null;
  }
}
