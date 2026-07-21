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

/** 소수점 3자리로 반올림 (밀리초 계측값처럼 부동소수 꼬리를 잘라내는 용도) */
export function round3(v: number): number {
  return parseFloat(v.toFixed(3));
}

/** 바이트 → "N.N MB" 형식 */
export function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Blob을 즉시 파일로 다운로드 (임시 <a> 클릭 방식) */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
