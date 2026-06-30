import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 초 → "MM:SS" 형식 */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 현재 재생 시간으로 가장 가까운 프레임 인덱스 탐색 (Binary Search) */
export function findFrameIndex(times: number[], currentTime: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= currentTime) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
