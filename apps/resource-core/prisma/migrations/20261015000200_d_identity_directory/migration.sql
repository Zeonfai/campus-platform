BEGIN;

CREATE TYPE "DScope" AS ENUM ('SELF', 'DEPARTMENT', 'MANAGED_ROOMS', 'ALL');

CREATE TYPE "DPowerType" AS ENUM ('NONE', 'FIXED', 'RAIL');

CREATE TABLE d_departments (id VARCHAR(100) PRIMARY KEY, name VARCHAR(200) NOT NULL UNIQUE);

CREATE TABLE d_users (id VARCHAR(100) PRIMARY KEY, username VARCHAR(200) NOT NULL UNIQUE,
 "displayName" VARCHAR(200) NOT NULL, "passwordHash" VARCHAR(300) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
 "departmentId" VARCHAR(100) REFERENCES d_departments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE d_roles (id VARCHAR(100) PRIMARY KEY, name VARCHAR(200) NOT NULL UNIQUE, scope "DScope" NOT NULL);

CREATE TABLE d_permissions (id VARCHAR(100) PRIMARY KEY, description VARCHAR(200) NOT NULL);

CREATE TABLE d_user_roles ("userId" VARCHAR(100) NOT NULL REFERENCES d_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "roleId" VARCHAR(100) NOT NULL REFERENCES d_roles(id) ON DELETE CASCADE ON UPDATE CASCADE, PRIMARY KEY ("userId", "roleId"));

CREATE TABLE d_role_permissions ("roleId" VARCHAR(100) NOT NULL REFERENCES d_roles(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "permissionId" VARCHAR(100) NOT NULL REFERENCES d_permissions(id) ON DELETE RESTRICT ON UPDATE CASCADE, PRIMARY KEY ("roleId", "permissionId"));

CREATE TABLE d_rooms (id VARCHAR(100) PRIMARY KEY, code VARCHAR(200) NOT NULL UNIQUE, name VARCHAR(200) NOT NULL,
 "departmentId" VARCHAR(100) REFERENCES d_departments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "restrictedToDepartment" BOOLEAN NOT NULL DEFAULT false, enabled BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT d_room_department_check CHECK (NOT "restrictedToDepartment" OR "departmentId" IS NOT NULL));

CREATE TABLE d_seats (id VARCHAR(100) PRIMARY KEY, "roomId" VARCHAR(100) NOT NULL REFERENCES d_rooms(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 code VARCHAR(200) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, "powerType" "DPowerType" NOT NULL,
 UNIQUE ("roomId", code));

CREATE TABLE d_managed_rooms ("userId" VARCHAR(100) NOT NULL REFERENCES d_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "roomId" VARCHAR(100) NOT NULL REFERENCES d_rooms(id) ON DELETE CASCADE ON UPDATE CASCADE, PRIMARY KEY ("userId", "roomId"));

CREATE TABLE d_sessions ("tokenHash" CHAR(64) PRIMARY KEY, "userId" VARCHAR(100) NOT NULL REFERENCES d_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "revokedAt" TIMESTAMPTZ(3));

CREATE TABLE d_login_buckets (key CHAR(64) PRIMARY KEY, "windowStart" TIMESTAMPTZ(3) NOT NULL, attempts INTEGER NOT NULL CHECK (attempts > 0));

CREATE TABLE d_audit_events (id UUID PRIMARY KEY, "actorId" VARCHAR(100) NOT NULL, action VARCHAR(100) NOT NULL,
 "targetId" VARCHAR(100) NOT NULL, "traceId" VARCHAR(100) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX "d_users_departmentId_idx" ON d_users ("departmentId");

CREATE INDEX "d_user_roles_roleId_idx" ON d_user_roles ("roleId");

CREATE INDEX "d_rooms_departmentId_idx" ON d_rooms ("departmentId");

CREATE INDEX "d_sessions_userId_expiresAt_idx" ON d_sessions ("userId", "expiresAt");

CREATE INDEX "d_sessions_expiresAt_idx" ON d_sessions ("expiresAt");

CREATE INDEX "d_login_buckets_windowStart_idx" ON d_login_buckets ("windowStart");

CREATE INDEX "d_audit_events_actorId_createdAt_idx" ON d_audit_events ("actorId", "createdAt");

COMMIT;
