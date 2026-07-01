// API 라우트 공통 헬퍼 — 인증 가드 / 본문 파싱 / 에러 응답 단일화
// (_ 프리픽스 디렉토리라 Next 라우팅에서 제외됨)
//
// 모든 에러 응답은 { error: string } 단일 스키마로 통일한다. 새 에러를 낼 때는
// 반드시 errorJson() 또는 그 위의 명명 헬퍼(unauthorized/forbidden/…)를 거칠 것.
// NextResponse.json({ error: ... }) 를 라우트에서 직접 만들지 않는다.
import { NextResponse } from "next/server";
import { HttpError } from "@/features/auth/lib/authz";

/** 공통 에러 응답: 항상 { error: string } 바디를 반환하는 단일 진입점.
 *  Retry-After 등 상태별 헤더가 필요한 경우에만 headers 를 전달한다. */
export function errorJson(
  message: string,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json({ error: message }, { status, headers });
}

export const unauthorized = () => errorJson("로그인이 필요합니다.", 401);

export const forbidden = (message = "권한이 없습니다.") => errorJson(message, 403);

export const notFound = (message = "찾을 수 없습니다.") => errorJson(message, 404);

export const conflict = (message: string) => errorJson(message, 409);

export const badRequest = (message: string) => errorJson(message, 400);

export const badBody = () => errorJson("잘못된 요청 본문", 400);

/** JSON 본문 파싱 — 실패 시 null (호출부에서 badBody() 반환) */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** HttpError → 공통 에러 응답, 그 외는 재던짐 (기존 catch 블록과 동일 동작) */
export function httpError(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return errorJson(e.message, e.status);
  }
  throw e;
}
