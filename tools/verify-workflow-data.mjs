import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const requireWorkflow = createRequire(new URL('../apps/workflow/package.json', import.meta.url));
const { Client } = requireWorkflow('pg'),
  { parse } = requireWorkflow('dotenv');
const { DATABASE_URL } = parse(readFileSync(resolve(root, 'apps/workflow/.env'), 'utf8'));
assert.equal(new URL(DATABASE_URL).hostname, '127.0.0.1');
const db = new Client({ connectionString: DATABASE_URL });
const schema = `it_m2_replay_${randomBytes(8).toString('hex')}`;
assert.match(schema, /^it_m2_replay_[a-f0-9]{16}$/);
const directory = resolve(root, 'apps/workflow/prisma/migrations');
const migrations = readdirSync(directory)
  .filter((name) => /^\d{14}_/.test(name))
  .sort();
let created = false;
await db.connect();
try {
  await db.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await db.query(`SET search_path TO "${schema}"`);
  for (const name of migrations)
    await db.query(readFileSync(resolve(directory, name, 'migration.sql'), 'utf8'));
  const count = (
    await db.query('SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1', [schema])
  ).rows[0].n;
  assert.equal(count, 14);
  await db.query('SET search_path TO public');
  const tables = [
    'wf_service_metadata',
    'm2_policy',
    'm2_application',
    'm2_step',
    'm2_write_receipt',
    'm2_outbox',
    'm2_audit_event',
  ];
  async function snapshot() {
    const result = {};
    for (const table of tables) {
      const rows = (
        await db.query(
          `SELECT row_to_json(t)::text AS r FROM ${table} t ORDER BY row_to_json(t)::text`,
        )
      ).rows;
      result[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    return result;
  }
  const before = await snapshot();
  for (const script of ['db:migrate', 'db:seed', 'db:seed']) {
    const child = spawnSync('pnpm', ['--filter', '@campus/workflow', script], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(child.status, 0, `${script} failed (configuration output suppressed)`);
  }
  assert.deepEqual(
    await snapshot(),
    before,
    'Migrations and seeds preserve existing policies and business records',
  );
  console.log(
    `PASS: ${migrations.length} workflow migrations replayed into an owned empty schema (${count} tables), repeated seed preserved all seven tables.`,
  );
} finally {
  try {
    await db.query('ROLLBACK');
    await db.query('SET search_path TO public');
    if (created) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await db.end();
  }
}
console.log('Owned temporary schema removed; application schemas and database volume preserved.');
