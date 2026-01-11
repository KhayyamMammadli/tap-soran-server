-- Add request completion + seller reviews

-- 1) Add completedAt to Request
ALTER TABLE "Request" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMPTZ;

-- 2) Create SellerReview table
CREATE TABLE IF NOT EXISTS "SellerReview" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerReview_pkey" PRIMARY KEY ("id")
);

-- Unique: one review per request
DO $$ BEGIN
  ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_requestId_key" UNIQUE ("requestId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "SellerReview_sellerId_idx" ON "SellerReview"("sellerId");
CREATE INDEX IF NOT EXISTS "SellerReview_buyerId_idx" ON "SellerReview"("buyerId");
CREATE INDEX IF NOT EXISTS "SellerReview_createdAt_idx" ON "SellerReview"("createdAt");
