import { useCallback } from "react";
import type { ChartStore } from "@/features/audio/lib/render/chart-store";

export function useChartFullXRange(store: ChartStore): () => [number, number] | null {
  return useCallback(() => {
    const { firstX, lastX } = store.snapshot();
    if (firstX === null || lastX === null || !(lastX > firstX)) return null;
    return [firstX, lastX];
  }, [store]);
}
