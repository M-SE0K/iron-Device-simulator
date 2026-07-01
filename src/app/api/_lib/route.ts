// API 라우트 공통 헬퍼 — 인증 가드 / 본문 파싱 / HttpError 응답 단일화
// (_ 프리픽스 디렉토리라 Next 라우팅에서 제외됨)
import { NextResponse } from "next/server";
import { HttpError } from "@/features/auth/lib/authz";

export const unauthorized = () =>
  NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

export const badBody = () =>
  NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });

/** JSON 본문 파싱 — 실패 시 null (호출부에서 badBody() 반환) */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** HttpError → JSON 응답, 그 외는 재던짐 (기존 catch 블록과 동일 동작) */
export function httpError(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  throw e;
}
