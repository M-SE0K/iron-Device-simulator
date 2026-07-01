// POST /api/projects — 음원 업로드 → WORK 프로젝트 + AudioAsset 생성 (multipart/form-data)
//   form fields: file(필수, audio/*), folderId(필수, 내 소유 WORK 폴더), name(선택, 기본=파일명)
import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/features/auth/lib/auth-server";
import { createProjectWithAudio } from "@/features/workspace/lib/workspace-server";
import { principalFrom } from "@/features/auth/lib/authz";
import { unauthorized, httpError } from "@/app/api/_lib/route";

export const runtime = "nodejs";

/** 확장자를 떼어 기본 프로젝트명으로 사용 */
function defaultName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export async function POST(req: Request) {
  const auth = await requireApprovedUser();
  if (!auth) return unauthorized();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "multipart/form-data 가 필요합니다." }, { status: 400 });
  }

  const file = form.get("file");
  const folderId = form.get("folderId");
  const nameField = form.get("name");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file 필드(오디오)가 필요합니다." }, { status: 400 });
  }
  if (typeof folderId !== "string" || !folderId) {
    return NextResponse.json({ error: "folderId 가 필요합니다." }, { status: 400 });
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const name =
    typeof nameField === "string" && nameField.trim() ? nameField : defaultName(file.name);

  try {
    const project = await createProjectWithAudio({
      name,
      folderId,
      principal: principalFrom(auth),
      file: { filename: file.name, mimeType: file.type, data },
    });
    return NextResponse.json(
      { project: { id: project.id, name: project.name, folderId: project.folderId } },
      { status: 201 },
    );
  } catch (e) {
    return httpError(e);
  }
}
