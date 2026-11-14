-- AlterTable
ALTER TABLE "User" ADD COLUMN "contactsVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "smsQuotaDay" TEXT,
ADD COLUMN "smsQuotaUsed" INTEGER NOT NULL DEFAULT 0;

-- 기존 연락처 버전 이어받기
UPDATE "User" u SET "contactsVersion" = c.v
FROM (SELECT "userId", MAX("version") AS v FROM "EmergencyContact" GROUP BY "userId") c
WHERE c."userId" = u."id";
