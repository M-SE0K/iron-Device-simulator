-- DropIndex
DROP INDEX "Folder_spaceType_parentId_idx";

-- DropIndex
DROP INDEX "Project_spaceType_folderId_idx";

-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "replacedById" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "tokenHash" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Folder_spaceType_parentId_deletedAt_idx" ON "Folder"("spaceType", "parentId", "deletedAt");

-- CreateIndex
CREATE INDEX "Project_spaceType_folderId_deletedAt_idx" ON "Project"("spaceType", "folderId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_replacedById_key" ON "Session"("replacedById");
