import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const backendRequire = createRequire(
  new URL('../apps/resource-core/package.json', import.meta.url),
);
const { Client } = backendRequire('pg');
const { parse } = backendRequire('dotenv');
const configuration = parse(readFileSync(resolve(root, 'apps/resource-core/.env'), 'utf8'));
const url = configuration.DATABASE_URL;
assert.ok(url && new URL(url).hostname === '127.0.0.1', 'Only the local database is allowed');
const client = new Client({ connectionString: url });
const directory = resolve(root, 'apps/resource-core/prisma/migrations');
const migrations = readdirSync(directory)
  .filter((name) => /^\d{14}_/.test(name))
  .sort();
const ownedSchema = `it_auth_replay_${randomBytes(8).toString('hex')}`;
assert.match(ownedSchema, /^it_auth_replay_[a-f0-9]{16}$/);
let created = false;
await client.connect();
try {
  await client.query(`CREATE SCHEMA "${ownedSchema}"`);
  created = true;
  await client.query(`SET search_path TO "${ownedSchema}"`);
  for (const name of migrations)
    await client.query(readFileSync(resolve(directory, name, 'migration.sql'), 'utf8'));
  const tableCount = (
    await client.query('SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=$1', [
      ownedSchema,
    ])
  ).rows[0].count;
  assert.equal(tableCount, 22);
  console.log(
    `PASS: ${migrations.length} versioned SQL migrations replayed in a newly created empty schema (${tableCount} tables).`,
  );
  await client.query('SET search_path TO public');

  const tables = [
    'd_departments',
    'd_users',
    'd_roles',
    'd_permissions',
    'd_user_roles',
    'd_role_permissions',
    'd_rooms',
    'd_seats',
    'd_managed_rooms',
    'd_service_metadata',
    'd_booking_policy',
    'd_opening_rules',
    'm1_bookings',
    'm1_write_receipts',
    'm1_resource_effects',
    'm1_commands',
    'm1_daily_codes',
    'd_notifications',
    'd_write_receipts',
  ];
  const snapshot = async () => {
    const result = {};
    for (const table of tables) {
      // Compute only a digest; password hashes and account data are never printed.
      const rows = (
        await client.query(
          `SELECT row_to_json(item)::text AS item FROM ${table} item ORDER BY row_to_json(item)::text`,
        )
      ).rows;
      result[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    result.credentials = createHash('sha256')
      .update(readFileSync(resolve(root, '.local/demo-accounts.json')))
      .digest('hex');
    return result;
  };
  const before = await snapshot();
  for (const script of ['db:migrate', 'db:seed', 'db:seed:demo']) {
    const child = spawnSync('pnpm', [script], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 60000,
    });
    if (child.status !== 0)
      throw new Error(
        `${script} failed; inspect local configuration (credential output suppressed)`,
      );
  }
  assert.deepEqual(
    await snapshot(),
    before,
    'Replay must not change metadata, accounts, permissions, rooms, seats or credential file',
  );
  assert.equal(statSync(resolve(root, '.local/demo-accounts.json')).mode & 0o777, 0o600);
  const ignored = spawnSync('git', ['check-ignore', '.local/demo-accounts.json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(ignored.status, 0);
  console.log(
    'PASS: migrations and both seeds replayed without changing metadata, demo accounts/passwords, grants, rooms/seats or private credential file; mode 0600 and Git ignored.',
  );
} finally {
  try {
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    if (created) await client.query(`DROP SCHEMA "${ownedSchema}" CASCADE`);
  } finally {
    await client.end();
  }
}
console.log(
  'Owned empty replay schema removed; existing application schemas and database volume preserved.',
);
