import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { components } from '@campus/contracts/api';
import type { DScope, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../platform/prisma.service.js';
import { dummyPasswordHash, verifyPassword } from './password.js';

export const identityInclude = {
  roles: { include: { role: { include: { permissions: true } } } },
  managedRooms: true,
} satisfies Prisma.DUserInclude;
type IdentityRow = Prisma.DUserGetPayload<{ include: typeof identityInclude }>;
export interface Identity {
  roleIds: string[];
  user: components['schemas']['User'];
  grants: { permission: string; scope: DScope }[];
  managedRoomIds: string[];
}
export function asIdentity(row: IdentityRow): Identity {
  const grants = row.roles.flatMap(({ role }) =>
    role.permissions.map(({ permissionId }) => ({ permission: permissionId, scope: role.scope })),
  );
  return {
    user: {
      id: row.id,
      displayName: row.displayName,
      ...(row.departmentId ? { departmentId: row.departmentId } : {}),
      enabled: row.enabled,
      permissions: [...new Set(grants.map((grant) => grant.permission))].sort(),
    },
    grants,
    roleIds: row.roles.map((item) => item.roleId).sort(),
    managedRoomIds: row.managedRooms.map(({ roomId }) => roomId),
  };
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function bearerToken(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '');
  if (!match?.[1]) throw new UnauthorizedException('Authentication required');
  return match[1];
}

@Injectable()
export class IdentityService {
  private computations = 0;
  constructor(private readonly db: PrismaService) {}

  private async consumeBucket(kind: string, subject: string, limit: number): Promise<void> {
    const key = hashToken(`login:${kind}:${subject}`);
    // Atomic in PostgreSQL, including parallel requests and process restarts.
    const rows = await this.db.$queryRaw<{ attempts: number }[]>`
      INSERT INTO d_login_buckets (key, "windowStart", attempts)
      VALUES (${key}, CURRENT_TIMESTAMP, 1)
      ON CONFLICT (key) DO UPDATE SET
        attempts = CASE WHEN d_login_buckets."windowStart" <= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
          THEN 1 ELSE LEAST(d_login_buckets.attempts + 1, 1000000) END,
        "windowStart" = CASE WHEN d_login_buckets."windowStart" <= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
          THEN CURRENT_TIMESTAMP ELSE d_login_buckets."windowStart" END
      RETURNING attempts`;
    if (!rows[0] || rows[0].attempts > limit)
      throw new HttpException('Too many login attempts; retry later', 429);
  }

  async login(username: string, password: string, address: string, traceId: string) {
    const normalized = username.trim().toLowerCase();
    // Bounded opportunistic cleanup of expired counters; never remove a live window.
    await this.db.$executeRaw`DELETE FROM d_login_buckets WHERE key IN (
      SELECT key FROM d_login_buckets WHERE "windowStart" <= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
      ORDER BY "windowStart" LIMIT 100 FOR UPDATE SKIP LOCKED
    )`;
    await this.consumeBucket('ip', address, 30);
    await this.consumeBucket('account', normalized, 10);
    if (this.computations >= 2) throw new HttpException('Login is busy; retry later', 429);
    this.computations++;
    try {
      const candidate = await this.db.dUser.findUnique({ where: { username: normalized } });
      const valid = await verifyPassword(
        password,
        candidate?.enabled ? candidate.passwordHash : dummyPasswordHash,
      );
      if (!valid || !candidate?.enabled) throw new UnauthorizedException('Invalid credentials');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM d_users WHERE id = ${candidate.id} FOR UPDATE`;
        const user = await tx.dUser.findUnique({
          where: { id: candidate.id },
          include: identityInclude,
        });
        if (!user?.enabled || user.passwordHash !== candidate.passwordHash)
          throw new UnauthorizedException('Invalid credentials');
        await tx.dSession.create({
          data: { tokenHash: hashToken(token), userId: user.id, expiresAt },
        });
        await tx.dAuditEvent.create({
          data: {
            id: randomUUID(),
            actorId: user.id,
            action: 'auth.login',
            targetId: user.id,
            traceId,
          },
        });
        return {
          accessToken: token,
          expiresAt: expiresAt.toISOString(),
          user: asIdentity(user).user,
        };
      });
    } finally {
      this.computations--;
    }
  }

  async authenticate(header: string | undefined): Promise<Identity> {
    const tokenHash = hashToken(bearerToken(header));
    const session = await this.db.dSession.findUnique({
      where: { tokenHash },
      include: { user: { include: identityInclude } },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      !session.user.enabled
    )
      throw new UnauthorizedException('Session expired or invalid');
    return asIdentity(session.user);
  }

  async logout(header: string | undefined, traceId: string): Promise<void> {
    const tokenHash = hashToken(bearerToken(header));
    await this.db.$transaction(async (tx) => {
      const changed = await tx.dSession.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (changed.count) {
        const session = await tx.dSession.findUniqueOrThrow({ where: { tokenHash } });
        await tx.dAuditEvent.create({
          data: {
            id: randomUUID(),
            actorId: session.userId,
            action: 'auth.logout',
            targetId: session.userId,
            traceId,
          },
        });
      }
    });
  }
}
