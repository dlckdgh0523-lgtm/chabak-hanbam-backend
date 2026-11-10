-- DropIndex
DROP INDEX "Alert_sourceEventId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Alert_sessionId_sourceEventId_key" ON "Alert"("sessionId", "sourceEventId");

