// 초기 데이터 시드: admin 계정 + Share Space 트리 + 레이아웃 점검용 더미 프로젝트/측정
// 실행: npm run db:seed   (멱등 — 여러 번 실행해도 중복 생성 안 됨)
// 설계 문서: docs/05-data-model.md §5, docs/02-workspace-model.md

import { PrismaClient, SpaceType, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// 부트스트랩 admin 자격증명 (운영 전 반드시 변경)
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@irontune.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

// Share Space 디바이스 분류 (명세 §3) — row 추가만으로 확장 가능
const DEVICES = ["Z3 SPK", "PA3 SPK", "B7 SPK", "R8 SPK"];
const CATEGORY = "Audio";

// 디바이스별 더미 오디오 프로젝트 (레이아웃 점검용)
const AUDIO_CLIPS = [
  { name: "재즈 롱 클립", durationSec: 300, tempAvg: 58, excAvg: 0.42 },
  { name: "EDM 비트", durationSec: 60, tempAvg: 71, excAvg: 0.61 },
];

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

/** 이름+폴더+공간 기준으로 프로젝트를 찾고 없으면 생성 (멱등) */
async function ensureProject(opts: {
  name: string;
  spaceType: SpaceType;
  ownerId: string | null;
  folderId: string;
  baseProjectId?: string | null;
}) {
  const existing = await prisma.project.findFirst({
    where: {
      name: opts.name,
      spaceType: opts.spaceType,
      folderId: opts.folderId,
      ownerId: opts.ownerId,
    },
  });
  if (existing) return existing;
  return prisma.project.create({
    data: {
      name: opts.name,
      spaceType: opts.spaceType,
      ownerId: opts.ownerId,
      folderId: opts.folderId,
      baseProjectId: opts.baseProjectId ?? null,
    },
  });
}

/** label 기준으로 측정을 찾고 없으면 생성 (멱등) */
async function ensureMeasurement(
  projectId: string,
  m: {
    label: string;
    speaker: string;
    powerW: number;
    durationSec: number;
    tempAvg: number;
    excAvg: number;
  },
) {
  const existing = await prisma.measurement.findFirst({
    where: { projectId, label: m.label },
  });
  if (existing) return existing;

  // MeasurementExport.summary 의 축약본 (메타 패널 점검용)
  const summary: Prisma.InputJsonValue = {
    temperature: { avg: m.tempAvg, min: m.tempAvg - 8, max: m.tempAvg + 12 },
    excursion: { avg: m.excAvg, min: 0, max: +(m.excAvg * 1.6).toFixed(3) },
    rtt: { avg: 11.2, min: 6, max: 28, p50: 10, p95: 22, p99: 27 },
    droppedFrameRatio: 0,
    totalDroppedFrames: 0,
  };

  return prisma.measurement.create({
    data: {
      projectId,
      label: m.label,
      speaker: m.speaker,
      powerW: m.powerW,
      durationSec: m.durationSec,
      frameCount: Math.round(m.durationSec * 100), // 100Hz
      summary,
    },
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

  // 3. 디바이스 → 오디오 카테고리 → 더미 프로젝트/측정
  let firstShareProjectId: string | null = null;
  for (const device of DEVICES) {
    const deviceFolder = await ensureFolder(device, "SHARE", shareRoot.id, null);
    const audioFolder = await ensureFolder(CATEGORY, "SHARE", deviceFolder.id, null);

    for (const clip of AUDIO_CLIPS) {
      const project = await ensureProject({
        name: clip.name,
        spaceType: "SHARE",
        ownerId: null,
        folderId: audioFolder.id,
      });
      await ensureMeasurement(project.id, {
        label: "baseline",
        speaker: device,
        powerW: 20,
        durationSec: clip.durationSec,
        tempAvg: clip.tempAvg,
        excAvg: clip.excAvg,
      });
      firstShareProjectId ??= project.id;
    }
    console.log(`  ✔ ${device} / ${CATEGORY} (+${AUDIO_CLIPS.length} 프로젝트)`);
  }

  // 4. admin 의 Work Space 더미 (트리·메타 패널 점검용)
  const adminLabel = admin.email.split("@")[0] || "admin";
  const workRoot = await ensureFolder(`${adminLabel}의 Work Space`, "WORK", null, admin.id);

  // 4-a. 루트 바로 아래 원본 작업 프로젝트
  const workOriginal = await ensureProject({
    name: "내 첫 분석",
    spaceType: "WORK",
    ownerId: admin.id,
    folderId: workRoot.id,
  });
  await ensureMeasurement(workOriginal.id, {
    label: "proposed",
    speaker: "Z3 SPK",
    powerW: 20,
    durationSec: 60,
    tempAvg: 64,
    excAvg: 0.55,
  });

  // 4-b. 하위 폴더 + Share 원본에서 가져온(Fork) 프로젝트
  const workSub = await ensureFolder("스피커 튜닝", "WORK", workRoot.id, admin.id);
  const forked = await ensureProject({
    name: "재즈 롱 클립 (포크)",
    spaceType: "WORK",
    ownerId: admin.id,
    folderId: workSub.id,
    baseProjectId: firstShareProjectId, // Share 원본 출처
  });
  await ensureMeasurement(forked.id, {
    label: "baseline",
    speaker: "Z3 SPK",
    powerW: 20,
    durationSec: 300,
    tempAvg: 58,
    excAvg: 0.42,
  });
  console.log(`✔ ${adminLabel} Work Space: 원본 1 + 포크 1 (하위폴더 '스피커 튜닝')`);

  console.log("시드 완료.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
