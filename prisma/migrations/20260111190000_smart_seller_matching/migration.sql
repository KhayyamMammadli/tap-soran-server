-- Smart Seller Matching: seller preferences + multi-category + targeted request delivery

-- 1) Enum for seller condition preference
DO $$ BEGIN
  CREATE TYPE "ConditionPref" AS ENUM ('ANY', 'NEW', 'USED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) User fields (shared location + seller preference fields)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "district" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sellerMinPrice" INTEGER;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sellerMaxPrice" INTEGER;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sellerCondition" "ConditionPref" NOT NULL DEFAULT 'ANY';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isPremium" BOOLEAN NOT NULL DEFAULT FALSE;

-- 3) Request fields (optional location + optional budget)
ALTER TABLE "Request" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Request" ADD COLUMN IF NOT EXISTS "district" TEXT;
ALTER TABLE "Request" ADD COLUMN IF NOT EXISTS "budget" INTEGER;

-- 4) RequestTarget join table
CREATE TABLE IF NOT EXISTS "RequestTarget" (
  "requestId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RequestTarget_pkey" PRIMARY KEY ("requestId", "sellerId")
);

DO $$ BEGIN
  ALTER TABLE "RequestTarget" ADD CONSTRAINT "RequestTarget_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "RequestTarget" ADD CONSTRAINT "RequestTarget_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "RequestTarget_sellerId_createdAt_idx" ON "RequestTarget"("sellerId", "createdAt");

-- 5) SellerCategory join table
CREATE TABLE IF NOT EXISTS "SellerCategory" (
  "sellerId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerCategory_pkey" PRIMARY KEY ("sellerId", "categoryId")
);

DO $$ BEGIN
  ALTER TABLE "SellerCategory" ADD CONSTRAINT "SellerCategory_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SellerCategory" ADD CONSTRAINT "SellerCategory_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "SellerCategory_categoryId_idx" ON "SellerCategory"("categoryId");
