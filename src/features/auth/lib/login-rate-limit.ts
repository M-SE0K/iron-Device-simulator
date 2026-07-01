// 로그인 brute-force 방어 — in-memory (단일 인스턴스 배포 전제, native-engine.ts 의 nativeLock 과 동일 패턴)
// 설계: docs/01-authentication.md §6 Phase2
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const EMAIL_MAX = 5;
const IP_MAX = 20;

interface Bucket {
  failures: number;
  windowStart: number;
  lockedUntil: number | null;
}

const buckets = new Map<string, Bucket>();

function getBucket(key: string): Bucket | undefined {
  const bucket = buckets.get(key);
  if (!bucket) return undefined;
  const now = Date.now();
  if (bucket.lockedUntil !== null && bucket.lockedUntil <= now) {
    buckets.delete(key);
    return undefined;
  }
  if (bucket.lockedUntil === null && now - bucket.windowStart > WINDOW_MS) {
    buckets.delete(key);
    return undefined;
  }
  return bucket;
}

function checkKey(key: string, max: number): { allowed: boolean; retryAfterSec?: number } {
  const bucket = getBucket(key);
  if (!bucket) return { allowed: true };
  if (bucket.lockedUntil !== null) {
    return { allowed: false, retryAfterSec: Math.ceil((bucket.lockedUntil - Date.now()) / 1000) };
  }
  if (bucket.failures >= max) {
    bucket.lockedUntil = Date.now() + LOCKOUT_MS;
    return { allowed: false, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
  }
  return { allowed: true };
}

/** 로그인 시도 전 호출 — 이메일/IP 둘 중 하나라도 잠겨있으면 거부 */
export function checkLoginRateLimit(ip: string, email: string): { allowed: boolean; retryAfterSec?: number } {
  const byEmail = checkKey(`email:${email}`, EMAIL_MAX);
  if (!byEmail.allowed) return byEmail;
  const byIp = checkKey(`ip:${ip}`, IP_MAX);
  if (!byIp.allowed) return byIp;
  return { allowed: true };
}

function recordFailure(key: string): void {
  const now = Date.now();
  const existing = getBucket(key);
  if (!existing) {
    buckets.set(key, { failures: 1, windowStart: now, lockedUntil: null });
    return;
  }
  existing.failures += 1;
}

/** 비밀번호 불일치 시 호출 */
export function recordLoginFailure(ip: string, email: string): void {
  recordFailure(`email:${email}`);
  recordFailure(`ip:${ip}`);
}

/** 로그인 성공 시 호출 — 해당 이메일/IP 카운터 초기화 */
export function resetLoginRateLimit(ip: string, email: string): void {
  buckets.delete(`email:${email}`);
  buckets.delete(`ip:${ip}`);
}
