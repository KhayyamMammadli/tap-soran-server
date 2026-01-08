-- Add seller contact fields
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "whatsapp" TEXT;

-- Add seller note to accepted requests
ALTER TABLE "AcceptedRequest" ADD COLUMN IF NOT EXISTS "sellerNote" TEXT;

-- Add JSON payload to notifications (deep-linking)
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "data" JSONB;
