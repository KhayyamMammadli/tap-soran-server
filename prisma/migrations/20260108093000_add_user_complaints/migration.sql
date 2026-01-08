-- Add UserComplaint table for non-chat complaints
-- ReportStatus enum already exists (used by MessageReport). This migration reuses it.

CREATE TABLE IF NOT EXISTS "UserComplaint" (
  "id" TEXT NOT NULL,
  "reporterId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "requestId" TEXT,
  "reason" TEXT NOT NULL,
  "details" TEXT,
  "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserComplaint_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "UserComplaint" ADD CONSTRAINT "UserComplaint_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "UserComplaint" ADD CONSTRAINT "UserComplaint_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "UserComplaint" ADD CONSTRAINT "UserComplaint_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "UserComplaint_targetUserId_idx" ON "UserComplaint"("targetUserId");
CREATE INDEX IF NOT EXISTS "UserComplaint_status_idx" ON "UserComplaint"("status");
CREATE INDEX IF NOT EXISTS "UserComplaint_createdAt_idx" ON "UserComplaint"("createdAt");
