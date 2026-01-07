/*
  Warnings:

  - You are about to drop the column `reportedUserId` on the `MessageReport` table. All the data in the column will be lost.
  - Added the required column `targetUserId` to the `MessageReport` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "MessageReport" DROP CONSTRAINT "MessageReport_reportedUserId_fkey";

-- DropForeignKey
ALTER TABLE "ModerationEvent" DROP CONSTRAINT "ModerationEvent_conversationId_fkey";

-- DropIndex
DROP INDEX "MessageReport_reportedUserId_idx";

-- AlterTable
ALTER TABLE "MessageReport" DROP COLUMN "reportedUserId",
ADD COLUMN     "targetUserId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "MessageReport_targetUserId_idx" ON "MessageReport"("targetUserId");

-- AddForeignKey
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
