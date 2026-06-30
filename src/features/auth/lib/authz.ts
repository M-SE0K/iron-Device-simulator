// 중앙 인가(Authorization) 헬퍼 — 명세 §5 권한표의 단일 구현체 (설계: docs/04-authorization.md)
//
// "규칙은 한 곳"(docs/04 §6): 모든 공간 자원(Folder/Project/AudioAsset)의 READ/WRITE 판단을
// can() 으로 수렴시킨다. 라우트/헬퍼에 규칙을 흩뿌리지 않는다.
//
// 주의: 이 파일은 순수 로직(prisma/jose 의존 없음)이므로 edge(middleware)에서도 import 가능하다.
//       자원 로드는 호출부(node 라우트)에서 하고, 평가만 여기서 한다.
import type { Role, UserStatus } from "@/features/auth/lib/auth";

export type SpaceType = "SHARE" | "WORK";
export type Action = "read" | "create" | "update" | "delete";

/** 인가 주체(인증된 신원) */
export interface Principal {
  userId: string;
  role: Role;
  status: UserStatus;
}

/** 공간에 속한 자원의 인가 판단에 필요한 최소 속성 */
export interface SpaceResource {
  spaceType: SpaceType;
  ownerId: string | null; // SHARE=null, WORK=소유자 userId
}

/**
 * 명세 §5 권한표:
 *   Share  READ  = 승인된 모든 사용자
 *   Share  WRITE = ADMIN (확장: UPLOADER)
 *   Work   READ/WRITE = 소유자(ownerId === userId)
 */
export function can(principal: Principal, action: Action, resource: SpaceResource): boolean {
  if (principal.status !== "APPROVED") return false;

  if (resource.spaceType === "SHARE") {
    if (action === "read") return true;
    return principal.role === "ADMIN"; // 확장 후보: || principal.role === "UPLOADER"
  }

  // WORK — 소유자만
  return resource.ownerId === principal.userId;
}

/** 인가 실패를 HTTP 상태로 매핑하기 위한 공통 예외 (라우트가 .status 로 응답) */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export class AuthzError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "AuthzError";
  }
}

/**
 * can() 을 강제하고 실패 시 throw.
 * - WORK 자원 거부는 **존재 노출 방지**를 위해 404(소유자 외엔 "없는 것"과 동일).
 * - SHARE 쓰기 거부는 403.
 */
export function assertCan(principal: Principal, action: Action, resource: SpaceResource): void {
  if (can(principal, action, resource)) return;
  if (resource.spaceType === "WORK") {
    throw new AuthzError(404, "리소스를 찾을 수 없습니다.");
  }
  throw new AuthzError(403, "권한이 없습니다.");
}

/** auth 토큰 payload → Principal 변환 헬퍼 */
export function principalFrom(p: { sub: string; role: Role; status: UserStatus }): Principal {
  return { userId: p.sub, role: p.role, status: p.status };
}
