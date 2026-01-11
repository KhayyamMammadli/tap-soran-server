-- Add blockedUntil to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "blockedUntil" TIMESTAMP(3);
