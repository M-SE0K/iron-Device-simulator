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

/** 현재 재생 시간 이하인 마지막 프레임 인덱스 탐색 (Binary Search) */
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

/**
 * 파일명을 확장자 기준으로 stem/ext 로 분리 (`"a.wav"` → `{ stem: "a", ext: "wav" }`).
 * 확장자가 없으면 ext는 "". 숨김 파일(`".gitignore"`)은 전체를 stem으로 본다.
 */
export function splitFileName(fileName: string | null | undefined): { stem: string; ext: string } {
  if (!fileName) return { stem: "", ext: "" };
  const dot = fileName.lastIndexOf(".");
  if (dot > 0 && dot < fileName.length - 1) {
    return { stem: fileName.slice(0, dot), ext: fileName.slice(dot + 1) };
  }
  return { stem: fileName, ext: "" };
}

/** 파일명으로 쓰기 부적합한 문자를 안전하게 치환 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "untitled";
}

/** 경로에서 마지막 세그먼트(name)와 상위 경로(parent)를 분리 — 홈 디렉터리는 ~ 로 축약 */
export function splitPath(path: string): { name: string; parent: string } {
  const clean = path.replace(/[/\\]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  const name = idx < 0 ? clean : clean.slice(idx + 1);
  let parent = idx < 0 ? "" : clean.slice(0, idx) || "/";
  parent = parent.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  return { name, parent };
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
  // revoke를 동기로 하면 일부 브라우저에서 다운로드가 취소된다 — 다음 tick으로 미룬다.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
