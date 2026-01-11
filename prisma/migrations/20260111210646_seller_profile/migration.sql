/*
  Warnings:

  - You are about to drop the column `reportedUserId` on the `MessageReport` table. All the data in the column will be lost.
  - Added the required column `targetUserId` to the `MessageReport` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "MessageReport" DROP CONSTRAINT "MessageReport_reportedUserId_fkey";

-- DropForeignKey
ALTER TABLE "ModerationEvent" DROP CONSTRAINT "ModerationEvent_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "Request" DROP CONSTRAINT "Request_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "SellerReview" DROP CONSTRAINT "SellerReview_buyerId_fkey";

-- DropForeignKey
ALTER TABLE "SellerReview" DROP CONSTRAINT "SellerReview_requestId_fkey";

-- DropForeignKey
ALTER TABLE "SellerReview" DROP CONSTRAINT "SellerReview_sellerId_fkey";

-- DropForeignKey
ALTER TABLE "UserComplaint" DROP CONSTRAINT "UserComplaint_reporterId_fkey";

-- DropForeignKey
ALTER TABLE "UserComplaint" DROP CONSTRAINT "UserComplaint_targetUserId_fkey";

-- DropIndex
DROP INDEX "MessageReport_reportedUserId_idx";

-- AlterTable
ALTER TABLE "EmailOtp" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MessageReport" DROP COLUMN "reportedUserId",
ADD COLUMN     "targetUserId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Request" ALTER COLUMN "completedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RequestTarget" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SellerCategory" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SellerReview" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UserComplaint" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MessageReport_targetUserId_idx" ON "MessageReport"("targetUserId");

-- AddForeignKey
ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserComplaint" ADD CONSTRAINT "UserComplaint_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserComplaint" ADD CONSTRAINT "UserComplaint_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
