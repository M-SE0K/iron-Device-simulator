-- 수동(직접) 정렬 순서 컬럼 추가 — 폴더/프로젝트를 같은 부모 형제 간 임의 순서로 재배치(midpoint)
-- AlterTable
ALTER TABLE "Folder" ADD COLUMN "position" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "position" DOUBLE PRECISION NOT NULL DEFAULT 0;
