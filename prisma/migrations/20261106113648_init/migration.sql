-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('CAR', 'PHONE', 'SENSOR');

-- CreateEnum
CREATE TYPE "Powertrain" AS ENUM ('EV', 'ICE', 'HEV', 'PHEV', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LinkRole" AS ENUM ('OWNER', 'CAR_DEVICE', 'PHONE_DEVICE');

-- CreateEnum
CREATE TYPE "LinkStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentDecision" AS ENUM ('GRANTED', 'DENIED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PermitStatus" AS ENUM ('ALLOWED', 'PROHIBITED', 'CONDITIONAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('PLANNED', 'ACTIVE', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('MOCK', 'PLEOS_EMULATOR', 'REAL');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('PLANNED', 'PREFLIGHT', 'ACTIVE', 'STOPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('PLEOS', 'BLE_SENSOR', 'USER', 'MOCK');

-- CreateEnum
CREATE TYPE "Quality" AS ENUM ('VALID', 'STALE', 'UNKNOWN', 'INVALID');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('REQUESTED', 'QUEUED', 'DISPATCHED', 'ACCEPTED', 'VERIFYING', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED', 'UNCONFIRMED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('RAISED', 'ACKED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('WSS', 'PUSH', 'SMS', 'LOCAL');

-- CreateEnum
CREATE TYPE "DeliveryStage" AS ENUM ('QUEUED', 'SENT', 'RECEIVED', 'DISPLAYED', 'USER_ACK', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "authSubject" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'ko-KR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Seoul',
    "deletionRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" "DeviceType" NOT NULL,
    "displayName" TEXT,
    "publicKey" TEXT,
    "tokenHash" TEXT,
    "pushTokenEncrypted" TEXT,
    "pushPlatform" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "powertrain" "Powertrain" NOT NULL DEFAULT 'UNKNOWN',
    "modelYear" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "role" "LinkRole" NOT NULL,
    "status" "LinkStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "VehicleLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingChallenge" (
    "id" TEXT NOT NULL,
    "carDeviceId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "decision" "ConsentDecision" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceId" TEXT,

    CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyContact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nameEncrypted" TEXT NOT NULL,
    "phoneEncrypted" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "campingStatus" "PermitStatus" NOT NULL DEFAULT 'UNKNOWN',
    "cookingStatus" "PermitStatus" NOT NULL DEFAULT 'UNKNOWN',
    "sourceUrl" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "meta" JSONB,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeatherSnapshot" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "region" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeatherSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "people" INTEGER NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'PLANNED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripSync" (
    "tripId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "appliedVersion" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripSync_pkey" PRIMARY KEY ("tripId","deviceId")
);

-- CreateTable
CREATE TABLE "CapabilityReport" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "sdkVersion" TEXT NOT NULL,
    "serviceVersion" TEXT,
    "emulatorVersion" TEXT,
    "permissions" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapabilityReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PowerPlan" (
    "id" TEXT NOT NULL,
    "tripId" TEXT,
    "inputs" JSONB NOT NULL,
    "assumptions" JSONB NOT NULL,
    "estimateMinKwh" DOUBLE PRECISION NOT NULL,
    "estimateMaxKwh" DOUBLE PRECISION NOT NULL,
    "reserveKwh" DOUBLE PRECISION NOT NULL,
    "confidence" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PowerPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SleepSession" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'PLANNED',
    "planVersion" INTEGER NOT NULL DEFAULT 1,
    "capabilityRevision" INTEGER,
    "executionMode" "ExecutionMode" NOT NULL DEFAULT 'MOCK',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SleepSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SleepPlanVersion" (
    "sessionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "desiredPlan" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SleepPlanVersion_pkey" PRIMARY KEY ("sessionId","version")
);

-- CreateTable
CREATE TABLE "Preflight" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stateRevision" INTEGER NOT NULL,
    "readiness" TEXT NOT NULL,
    "blockers" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Preflight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SensorBinding" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sensorType" TEXT NOT NULL,
    "protocolVersion" TEXT,
    "calibratedAt" TIMESTAMP(3),
    "expectedIntervalMs" INTEGER NOT NULL DEFAULT 5000,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "SensorBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetrySample" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "sessionId" TEXT,
    "metric" TEXT NOT NULL,
    "value" JSONB,
    "unit" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "sourceDeviceId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" INTEGER NOT NULL,
    "bootId" TEXT NOT NULL,
    "quality" "Quality" NOT NULL DEFAULT 'VALID',

    CONSTRAINT "TelemetrySample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleStateCache" (
    "vehicleId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleStateCache_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateTable
CREATE TABLE "Command" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "sessionId" TEXT,
    "action" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'REQUESTED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "userActionId" TEXT NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "capabilityRev" INTEGER NOT NULL,
    "observed" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Command_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandAttempt" (
    "id" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "result" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CommandAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "executionMode" "ExecutionMode" NOT NULL DEFAULT 'MOCK',
    "status" "AlertStatus" NOT NULL DEFAULT 'RAISED',
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertAck" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "userId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertAck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "recipientRef" TEXT NOT NULL,
    "status" "DeliveryStage" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxEvent" (
    "eventId" TEXT NOT NULL,
    "sourceDeviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "principal" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("principal","route","key")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_authSubject_key" ON "User"("authSubject");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE INDEX "VehicleLink_vehicleId_idx" ON "VehicleLink"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleLink_deviceId_idx" ON "VehicleLink"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleLink_userId_vehicleId_deviceId_key" ON "VehicleLink"("userId", "vehicleId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PairingChallenge_secretHash_key" ON "PairingChallenge"("secretHash");

-- CreateIndex
CREATE INDEX "PairingChallenge_expiresAt_idx" ON "PairingChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "ConsentEvent_userId_purpose_occurredAt_idx" ON "ConsentEvent"("userId", "purpose", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyContact_userId_priority_key" ON "EmergencyContact"("userId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "Place_providerId_key" ON "Place"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_tripId_key" ON "Review"("tripId");

-- CreateIndex
CREATE INDEX "Review_placeId_visibility_idx" ON "Review"("placeId", "visibility");

-- CreateIndex
CREATE INDEX "WeatherSnapshot_region_validFrom_validTo_idx" ON "WeatherSnapshot"("region", "validFrom", "validTo");

-- CreateIndex
CREATE INDEX "Trip_vehicleId_startAt_idx" ON "Trip"("vehicleId", "startAt");

-- CreateIndex
CREATE INDEX "Trip_userId_startAt_idx" ON "Trip"("userId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityReport_vehicleId_revision_key" ON "CapabilityReport"("vehicleId", "revision");

-- CreateIndex
CREATE INDEX "SleepSession_vehicleId_status_idx" ON "SleepSession"("vehicleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SensorBinding_deviceId_sensorType_key" ON "SensorBinding"("deviceId", "sensorType");

-- CreateIndex
CREATE INDEX "TelemetrySample_vehicleId_metric_observedAt_idx" ON "TelemetrySample"("vehicleId", "metric", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "TelemetrySample_sessionId_observedAt_idx" ON "TelemetrySample"("sessionId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetrySample_sourceDeviceId_bootId_seq_metric_key" ON "TelemetrySample"("sourceDeviceId", "bootId", "seq", "metric");

-- CreateIndex
CREATE INDEX "Command_vehicleId_status_idx" ON "Command"("vehicleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommandAttempt_commandId_attemptNo_key" ON "CommandAttempt"("commandId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_sourceEventId_key" ON "Alert"("sourceEventId");

-- CreateIndex
CREATE INDEX "Alert_sessionId_raisedAt_idx" ON "Alert"("sessionId", "raisedAt");

-- CreateIndex
CREATE INDEX "Delivery_alertId_channel_idx" ON "Delivery"("alertId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_eventId_key" ON "OutboxEvent"("eventId");

-- CreateIndex
CREATE INDEX "OutboxEvent_processedAt_createdAt_idx" ON "OutboxEvent"("processedAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateId_version_idx" ON "OutboxEvent"("aggregateId", "version");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_target_occurredAt_idx" ON "AuditEvent"("target", "occurredAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLink" ADD CONSTRAINT "VehicleLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLink" ADD CONSTRAINT "VehicleLink_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLink" ADD CONSTRAINT "VehicleLink_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingChallenge" ADD CONSTRAINT "PairingChallenge_carDeviceId_fkey" FOREIGN KEY ("carDeviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripSync" ADD CONSTRAINT "TripSync_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripSync" ADD CONSTRAINT "TripSync_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityReport" ADD CONSTRAINT "CapabilityReport_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityReport" ADD CONSTRAINT "CapabilityReport_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PowerPlan" ADD CONSTRAINT "PowerPlan_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SleepSession" ADD CONSTRAINT "SleepSession_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SleepSession" ADD CONSTRAINT "SleepSession_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SleepPlanVersion" ADD CONSTRAINT "SleepPlanVersion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SleepSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Preflight" ADD CONSTRAINT "Preflight_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SleepSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SensorBinding" ADD CONSTRAINT "SensorBinding_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySample" ADD CONSTRAINT "TelemetrySample_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySample" ADD CONSTRAINT "TelemetrySample_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SleepSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleStateCache" ADD CONSTRAINT "VehicleStateCache_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SleepSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandAttempt" ADD CONSTRAINT "CommandAttempt_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SleepSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertAck" ADD CONSTRAINT "AlertAck_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertAck" ADD CONSTRAINT "AlertAck_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
