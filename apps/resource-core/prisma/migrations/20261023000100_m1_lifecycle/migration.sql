BEGIN;
ALTER TABLE d_booking_policy
 ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
 ADD COLUMN "checkInBeforeMinutes" INTEGER NOT NULL DEFAULT 15 CHECK ("checkInBeforeMinutes" BETWEEN 0 AND 60),
 ADD COLUMN "reminderBeforeMinutes" INTEGER NOT NULL DEFAULT 15 CHECK ("reminderBeforeMinutes" BETWEEN 0 AND 60),
 ADD COLUMN "reminderAfterMinutes" INTEGER NOT NULL DEFAULT 10 CHECK ("reminderAfterMinutes" BETWEEN 0 AND 59),
 ADD COLUMN "noShowAfterMinutes" INTEGER NOT NULL DEFAULT 15 CHECK ("noShowAfterMinutes" BETWEEN 1 AND 60),
 ADD CONSTRAINT d_policy_reminder_before_expiry CHECK ("reminderAfterMinutes" < "noShowAfterMinutes");
ALTER TABLE m1_bookings
 ADD COLUMN "enforceNoShow" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "policyRevision" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "checkInBeforeMinutes" INTEGER NOT NULL DEFAULT 15,
 ADD COLUMN "noShowAfterMinutes" INTEGER NOT NULL DEFAULT 15,
 ADD COLUMN "reminderBeforeAt" TIMESTAMPTZ(3),
 ADD COLUMN "reminderAfterAt" TIMESTAMPTZ(3),
 ADD COLUMN "nextActionAt" TIMESTAMPTZ(3),
 ADD COLUMN "checkedInAt" TIMESTAMPTZ(3),
 ADD COLUMN "completedAt" TIMESTAMPTZ(3),
 ADD COLUMN "violationAt" TIMESTAMPTZ(3),
 ADD COLUMN "failedCodeAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "codeAttemptWindow" TIMESTAMPTZ(3);
ALTER TABLE m1_bookings ALTER COLUMN "enforceNoShow" SET DEFAULT true;
ALTER TABLE m1_resource_effects ADD COLUMN "releasedAt" TIMESTAMPTZ(3);
UPDATE m1_resource_effects SET "releasedAt" = "updatedAt" WHERE state = 'RELEASED';
UPDATE m1_bookings SET
 "reminderBeforeAt" = "startsAt" - INTERVAL '15 minutes',
 "reminderAfterAt" = "startsAt" + INTERVAL '10 minutes',
 "nextActionAt" = CASE WHEN status='BOOKED' THEN "startsAt" - INTERVAL '15 minutes'
 WHEN status='CHECKED_IN' THEN "endsAt" ELSE NULL END;
CREATE INDEX "m1_bookings_status_nextActionAt_idx" ON m1_bookings (status,"nextActionAt");
CREATE TABLE m1_daily_codes ("roomId" VARCHAR(100) NOT NULL REFERENCES d_rooms(id) ON DELETE RESTRICT ON UPDATE CASCADE, date CHAR(10) NOT NULL, code CHAR(8) NOT NULL, PRIMARY KEY ("roomId",date));
CREATE UNIQUE INDEX "m1_daily_codes_date_code_key" ON m1_daily_codes (date,code);
CREATE TABLE d_notifications (id UUID PRIMARY KEY, "userId" VARCHAR(100) NOT NULL REFERENCES d_users(id) ON DELETE RESTRICT ON UPDATE CASCADE, "eventKey" VARCHAR(200) NOT NULL, title VARCHAR(200) NOT NULL, body VARCHAR(1000) NOT NULL, read BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "d_notifications_userId_eventKey_key" ON d_notifications ("userId","eventKey");
CREATE INDEX "d_notifications_userId_id_idx" ON d_notifications ("userId",id);
CREATE TABLE d_write_receipts (id VARCHAR(200) PRIMARY KEY, fingerprint CHAR(64) NOT NULL, result JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
COMMIT;
