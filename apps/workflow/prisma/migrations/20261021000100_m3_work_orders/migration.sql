-- CreateTable
CREATE TABLE "m3_policy" (
    "id" VARCHAR(100) NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "responseMinutes" INTEGER NOT NULL,
    "repairMinutes" INTEGER NOT NULL,
    "acceptanceMinutes" INTEGER NOT NULL,
    "createdBy" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "m3_policy_pkey" PRIMARY KEY ("id","revision")
);

-- CreateTable
CREATE TABLE "m3_work_order" (
    "id" UUID NOT NULL,
    "roomId" VARCHAR(100) NOT NULL,
    "departmentId" VARCHAR(100),
    "reporterId" VARCHAR(100) NOT NULL,
    "assigneeId" VARCHAR(100),
    "assigneeName" VARCHAR(200),
    "repairerId" VARCHAR(100),
    "category" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'NEW',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "policyId" VARCHAR(100) NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "responseDeadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "repairDeadlineAt" TIMESTAMPTZ(3),
    "acceptanceDeadlineAt" TIMESTAMPTZ(3),
    "repairRound" INTEGER NOT NULL DEFAULT 1,
    "blockStartsAt" TIMESTAMPTZ(3),
    "escalationRecipientIds" JSONB NOT NULL,
    "rating" INTEGER,
    "ratingComment" VARCHAR(1000),
    "syncError" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "m3_work_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "m3_assignment" (
    "id" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "assigneeId" VARCHAR(100) NOT NULL,
    "assigneeName" VARCHAR(200) NOT NULL,
    "assignedBy" VARCHAR(100) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "m3_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "m3_write_receipt" (
    "id" VARCHAR(200) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "m3_write_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "m3_outbox" (
    "operationId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderRevision" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "actorId" VARCHAR(100) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "startsAt" TIMESTAMPTZ(3),
    "state" VARCHAR(20) NOT NULL DEFAULT 'READY',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leasedUntil" TIMESTAMPTZ(3),
    "lastError" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "m3_outbox_pkey" PRIMARY KEY ("operationId")
);

-- CreateTable
CREATE TABLE "m3_audit_event" (
    "id" UUID NOT NULL,
    "workOrderId" UUID,
    "actorId" VARCHAR(100) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "m3_audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "m3_escalation" (
    "id" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "stage" VARCHAR(20) NOT NULL,
    "round" INTEGER NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "recipientIds" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "m3_escalation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "m3_work_order_reporterId_id_idx" ON "m3_work_order"("reporterId", "id");

-- CreateIndex
CREATE INDEX "m3_work_order_assigneeId_id_idx" ON "m3_work_order"("assigneeId", "id");

-- CreateIndex
CREATE INDEX "m3_work_order_status_responseDeadlineAt_idx" ON "m3_work_order"("status", "responseDeadlineAt");

-- CreateIndex
CREATE INDEX "m3_work_order_status_repairDeadlineAt_idx" ON "m3_work_order"("status", "repairDeadlineAt");

-- CreateIndex
CREATE INDEX "m3_work_order_status_acceptanceDeadlineAt_idx" ON "m3_work_order"("status", "acceptanceDeadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "m3_assignment_workOrderId_revision_key" ON "m3_assignment"("workOrderId", "revision");

-- CreateIndex
CREATE INDEX "m3_outbox_state_availableAt_idx" ON "m3_outbox"("state", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "m3_outbox_workOrderId_workOrderRevision_key" ON "m3_outbox"("workOrderId", "workOrderRevision");

-- CreateIndex
CREATE INDEX "m3_audit_event_workOrderId_createdAt_idx" ON "m3_audit_event"("workOrderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "m3_escalation_workOrderId_stage_round_key" ON "m3_escalation"("workOrderId", "stage", "round");

-- AddForeignKey
ALTER TABLE "m3_work_order" ADD CONSTRAINT "m3_work_order_policyId_policyRevision_fkey" FOREIGN KEY ("policyId", "policyRevision") REFERENCES "m3_policy"("id", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "m3_assignment" ADD CONSTRAINT "m3_assignment_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "m3_work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "m3_outbox" ADD CONSTRAINT "m3_outbox_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "m3_work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "m3_audit_event" ADD CONSTRAINT "m3_audit_event_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "m3_work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "m3_escalation" ADD CONSTRAINT "m3_escalation_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "m3_work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guard policy inputs, state machines and durable command invariants at the database boundary.
ALTER TABLE "m3_policy"
 ADD CONSTRAINT "m3_policy_revision_check" CHECK ("revision">0),
 ADD CONSTRAINT "m3_policy_sla_check" CHECK ("responseMinutes" BETWEEN 1 AND 43200 AND "repairMinutes" BETWEEN 1 AND 43200 AND "acceptanceMinutes" BETWEEN 1 AND 43200);
ALTER TABLE "m3_work_order"
 ADD CONSTRAINT "m3_work_order_revision_check" CHECK ("revision">0 AND "repairRound">0),
 ADD CONSTRAINT "m3_work_order_status_check" CHECK ("status" IN ('NEW','ASSIGNED','BLOCK_PENDING','IN_REPAIR','AWAITING_ACCEPTANCE','RELEASE_PENDING','CLOSED','CANCELLED','SYNC_FAILED')),
 ADD CONSTRAINT "m3_work_order_rating_check" CHECK ("rating" IS NULL OR ("rating" BETWEEN 1 AND 5 AND "status"='CLOSED')),
 ADD CONSTRAINT "m3_work_order_repairer_check" CHECK ("status" NOT IN ('BLOCK_PENDING','IN_REPAIR','AWAITING_ACCEPTANCE','RELEASE_PENDING','CLOSED') OR ("assigneeId" IS NOT NULL AND "repairerId" IS NOT NULL AND "blockStartsAt" IS NOT NULL));
ALTER TABLE "m3_assignment" ADD CONSTRAINT "m3_assignment_revision_check" CHECK ("revision">0);
ALTER TABLE "m3_outbox"
 ADD CONSTRAINT "m3_outbox_revision_check" CHECK ("workOrderRevision">0 AND "attempts">=0),
 ADD CONSTRAINT "m3_outbox_kind_check" CHECK ("kind" IN ('BLOCK','RELEASE') AND ("kind"<>'BLOCK' OR "startsAt" IS NOT NULL)),
 ADD CONSTRAINT "m3_outbox_state_check" CHECK ("state" IN ('READY','PROCESSING','SUPERSEDED','SUCCEEDED','FAILED')),
 ADD CONSTRAINT "m3_outbox_lease_check" CHECK ("state"<>'PROCESSING' OR ("leaseToken" IS NOT NULL AND "leasedUntil" IS NOT NULL));
ALTER TABLE "m3_escalation"
 ADD CONSTRAINT "m3_escalation_stage_check" CHECK ("stage" IN ('RESPONSE','REPAIR','ACCEPTANCE')),
 ADD CONSTRAINT "m3_escalation_level_check" CHECK ("round">0 AND "level"=1);
