// 인증 핵심 유틸 (설계: docs/01-authentication.md)
// - 비밀번호 해싱(bcrypt)
// - JWT 발급/검증(jose — edge/node 양쪽 호환)
// - 쿠키 기반 토큰 전송
//
// 주의: 이 파일은 jose 만 사용하므로 edge(middleware)에서도 import 가능하다.
//       bcrypt/prisma 의존은 lib/auth-server.ts 로 분리한다.
import { SignJWT, jwtVerify } from "jose";

export const TOKEN_COOKIE = "irontune_token";
export const REFRESH_COOKIE = "irontune_refresh";

// Phase 2: refresh 토큰 도입 — access 는 짧게, refresh(7일)가 세션을 이어감. (docs/01 §5.2)
const ACCESS_TTL_MINUTES = 15;
const ACCESS_TTL = `${ACCESS_TTL_MINUTES}m`;
export const ACCESS_TTL_SECONDS = ACCESS_TTL_MINUTES * 60;
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7; // 7일

export type Role = "ADMIN" | "USER";
export type UserStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface AuthTokenPayload {
  sub: string; // userId (= project_sessions.user_id 연결점, 명세 §7)
  email: string;
  role: Role;
  status: UserStatus;
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET 환경변수가 설정되지 않았습니다 (.env 확인).");
  }
  return new TextEncoder().encode(secret);
}

/** 사용자 정보를 담아 서명된 JWT 발급 */
export async function signToken(payload: AuthTokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role, status: payload.status })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(getSecret());
}

/** JWT 서명·만료 검증 → payload 반환. 실패 시 null */
export async function verifyToken(token: string): Promise<AuthTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: payload.email as string,
      role: payload.role as Role,
      status: payload.status as UserStatus,
    };
  } catch {
    return null;
  }
}
