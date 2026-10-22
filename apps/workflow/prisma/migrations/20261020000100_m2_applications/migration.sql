CREATE TABLE "m2_policy" (
"id" VARCHAR(100) NOT NULL, "revision" INTEGER NOT NULL, "name" VARCHAR(200) NOT NULL,
"timeoutMinutes" INTEGER NOT NULL, "steps" JSONB NOT NULL, "createdBy" VARCHAR(100) NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "m2_policy_pkey" PRIMARY KEY ("id","revision"),
CONSTRAINT "m2_policy_limits" CHECK ("revision">=1 AND "timeoutMinutes" BETWEEN 1 AND 10080 AND jsonb_typeof("steps")='array' AND jsonb_array_length("steps") BETWEEN 2 AND 10));
CREATE TABLE "m2_application" (
"id" UUID NOT NULL, "roomId" VARCHAR(100) NOT NULL, "applicantId" VARCHAR(100) NOT NULL,
"departmentId" VARCHAR(100), "purpose" VARCHAR(1000) NOT NULL, "startsAt" TIMESTAMPTZ(3) NOT NULL,
"endsAt" TIMESTAMPTZ(3) NOT NULL, "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
"policyId" VARCHAR(100) NOT NULL, "policyRevision" INTEGER NOT NULL,
"status" VARCHAR(30) NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
"targetStatus" VARCHAR(30), "syncError" VARCHAR(100),
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "m2_application_pkey" PRIMARY KEY ("id"),
CONSTRAINT "m2_application_policyId_policyRevision_fkey" FOREIGN KEY ("policyId","policyRevision") REFERENCES "m2_policy"("id","revision") ON DELETE RESTRICT ON UPDATE CASCADE,
CONSTRAINT "m2_application_interval" CHECK ("endsAt">"startsAt" AND "deadlineAt"<="startsAt"),
CONSTRAINT "m2_application_revision" CHECK ("revision">=1),
CONSTRAINT "m2_application_status" CHECK ("status" IN ('PENDING','SYNCING','APPROVED','REJECTED','WITHDRAWN','EXPIRED','RELEASE_PENDING','SYNC_FAILED')),
CONSTRAINT "m2_application_target" CHECK ("targetStatus" IS NULL OR "targetStatus" IN ('WITHDRAWN','EXPIRED')));
CREATE INDEX "m2_application_applicantId_id_idx" ON "m2_application"("applicantId","id");
CREATE INDEX "m2_application_status_deadlineAt_idx" ON "m2_application"("status","deadlineAt");
CREATE TABLE "m2_step" (
"id" UUID NOT NULL, "applicationId" UUID NOT NULL, "position" INTEGER NOT NULL,
"roleId" VARCHAR(100) NOT NULL, "scope" VARCHAR(30) NOT NULL,
"status" VARCHAR(20) NOT NULL DEFAULT 'PENDING', "decidedBy" VARCHAR(100),
"comment" VARCHAR(1000), "decidedAt" TIMESTAMPTZ(3),
CONSTRAINT "m2_step_pkey" PRIMARY KEY ("id"),
CONSTRAINT "m2_step_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "m2_application"("id") ON DELETE CASCADE ON UPDATE CASCADE,
CONSTRAINT "m2_step_position" CHECK ("position" BETWEEN 1 AND 10),
CONSTRAINT "m2_step_scope" CHECK ("scope" IN ('DEPARTMENT','MANAGED_ROOMS','ALL')),
CONSTRAINT "m2_step_status" CHECK ("status" IN ('PENDING','APPROVED','REJECTED')),
CONSTRAINT "m2_step_decision" CHECK (("status"='PENDING' AND "decidedBy" IS NULL AND "decidedAt" IS NULL AND "comment" IS NULL) OR ("status"<>'PENDING' AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "comment" IS NOT NULL)));
CREATE UNIQUE INDEX "m2_step_applicationId_position_key" ON "m2_step"("applicationId","position");
CREATE INDEX "m2_step_roleId_status_idx" ON "m2_step"("roleId","status");
CREATE TABLE "m2_write_receipt" (
"id" VARCHAR(200) NOT NULL, "fingerprint" CHAR(64) NOT NULL, "result" JSONB NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "m2_write_receipt_pkey" PRIMARY KEY ("id"));
CREATE TABLE "m2_outbox" (
"operationId" UUID NOT NULL, "applicationId" UUID NOT NULL, "applicationRevision" INTEGER NOT NULL,
"kind" VARCHAR(20) NOT NULL, "actorId" VARCHAR(100) NOT NULL, "reason" VARCHAR(1000) NOT NULL,
"state" VARCHAR(20) NOT NULL DEFAULT 'READY', "attempts" INTEGER NOT NULL DEFAULT 0,
"availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseToken" UUID,
"leasedUntil" TIMESTAMPTZ(3), "lastError" VARCHAR(100),
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMPTZ(3),
CONSTRAINT "m2_outbox_pkey" PRIMARY KEY ("operationId"),
CONSTRAINT "m2_outbox_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "m2_application"("id") ON DELETE CASCADE ON UPDATE CASCADE,
CONSTRAINT "m2_outbox_revision" CHECK ("applicationRevision">=1 AND "attempts">=0),
CONSTRAINT "m2_outbox_kind" CHECK ("kind" IN ('OCCUPY','RELEASE')),
CONSTRAINT "m2_outbox_state" CHECK ("state" IN ('READY','PROCESSING','SUCCEEDED','FAILED','SUPERSEDED')));
CREATE UNIQUE INDEX "m2_outbox_applicationId_applicationRevision_key" ON "m2_outbox"("applicationId","applicationRevision");
CREATE INDEX "m2_outbox_state_availableAt_idx" ON "m2_outbox"("state","availableAt");
CREATE TABLE "m2_audit_event" (
"id" UUID NOT NULL, "applicationId" UUID, "actorId" VARCHAR(100) NOT NULL,
"action" VARCHAR(100) NOT NULL, "data" JSONB NOT NULL,
"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "m2_audit_event_pkey" PRIMARY KEY ("id"));
CREATE INDEX "m2_audit_event_applicationId_createdAt_idx" ON "m2_audit_event"("applicationId","createdAt");
