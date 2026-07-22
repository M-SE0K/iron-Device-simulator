/**
 * units.ts — 엔진 raw 출력 → UI 표기 단위 변환 및 표시 형식.
 *
 * WASM 엔진이 내보내는 excursion raw 값은 UI 표기 단위(mm)와 스케일이 다르다.
 * 이 변환 계수와 표시 자릿수를 차트/기록 목록이 각자 들고 있으면 서로 어긋날 수
 * 있어(실제로 ExcursionChart와 RecordsDrawer가 따로 정의하고 있었다) 여기로 모은다.
 */

/** WASM 엔진 excursion raw 값 → mm 변환 계수 */
export const MM_SCALE = 1 / 1000;

/** mm 표시 소수 자릿수 — 차트 축/헤더와 기록 목록이 같은 정밀도를 쓰도록 */
export const MM_DECIMALS = 3;

/** raw → mm */
export function toMm(v: number): number {
  return v * MM_SCALE;
}

/** raw → "N.NNN" mm 문자열. 값이 없거나 유한하지 않으면 "—" */
export function formatMm(raw: number | null | undefined): string {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return "—";
  return toMm(raw).toFixed(MM_DECIMALS);
}
