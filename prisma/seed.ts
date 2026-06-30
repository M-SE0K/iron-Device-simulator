// 초기 데이터 시드: admin 계정 + Share Space 트리
// 실행: npm run db:seed   (멱등 — 여러 번 실행해도 중복 생성 안 됨)
// 설계 문서: docs/05-data-model.md §5

import { PrismaClient, SpaceType } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// 부트스트랩 admin 자격증명 (운영 전 반드시 변경)
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@irontune.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

// Share Space 디바이스 분류 (명세 §3) — row 추가만으로 확장 가능
const DEVICES = ["Z3 SPK", "PA3 SPK", "B7 SPK", "R8 SPK"];
const CATEGORY = "오디오";

/** 이름+부모+공간 기준으로 폴더를 찾고 없으면 생성 (멱등) */
async function ensureFolder(
  name: string,
  spaceType: SpaceType,
  parentId: string | null,
  ownerId: string | null,
) {
  const existing = await prisma.folder.findFirst({
    where: { name, spaceType, parentId, ownerId },
  });
  if (existing) return existing;
  return prisma.folder.create({
    data: { name, spaceType, parentId, ownerId },
  });
}

async function main() {
  // 1. admin 계정 (upsert)
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { role: "ADMIN", status: "APPROVED" },
    create: {
      email: ADMIN_EMAIL,
      passwordHash,
      role: "ADMIN",
      status: "APPROVED",
    },
  });
  console.log(`✔ admin: ${admin.email}`);

  // 2. Share Space 루트
  const shareRoot = await ensureFolder("Share Space", "SHARE", null, null);
  console.log(`✔ Share 루트: ${shareRoot.name}`);

  // 3. 디바이스 → 오디오 카테고리
  for (const device of DEVICES) {
    const deviceFolder = await ensureFolder(device, "SHARE", shareRoot.id, null);
    await ensureFolder(CATEGORY, "SHARE", deviceFolder.id, null);
    console.log(`  ✔ ${device} / ${CATEGORY}`);
  }

  console.log("시드 완료.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
