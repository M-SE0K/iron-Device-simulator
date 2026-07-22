const MM_SCALE = 1 / 1000;

export const MM_DECIMALS = 3;

export function toMm(v: number): number {
  return v * MM_SCALE;
}

export function formatMm(raw: number | null | undefined): string {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return "—";
  return toMm(raw).toFixed(MM_DECIMALS);
}
