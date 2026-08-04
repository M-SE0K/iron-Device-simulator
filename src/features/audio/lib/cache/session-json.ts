export function readSessionJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 키 존재 여부. null은 브라우저 외 환경이거나 storage 접근 자체가 실패한 경우다. */
export function hasSessionJson(key: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key) !== null;
  } catch {
    return null;
  }
}

export function writeSessionJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

export function removeSessionJson(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
  }
}
