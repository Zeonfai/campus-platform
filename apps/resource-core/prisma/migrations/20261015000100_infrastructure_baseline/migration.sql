CREATE TABLE "d_service_metadata" (
  "key" VARCHAR(100) NOT NULL,
  "value" VARCHAR(500) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "d_service_metadata_pkey" PRIMARY KEY ("key")
);
