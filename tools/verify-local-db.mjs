import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const backendRequire = createRequire(
  new URL('../apps/resource-core/package.json', import.meta.url),
);
const { Client } = backendRequire('pg');
const { parse } = backendRequire('dotenv');
const empty = process.argv.includes('--expect-empty');
const results = [];

async function mustReject(connectionString, expectedCode) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000 });
  let actual;
  try {
    await client.connect();
  } catch (error) {
    actual = error.code;
  } finally {
    await client.end();
  }
  assert.equal(
    actual,
    expectedCode,
    'Connection must fail for the expected database permission or authentication reason',
  );
}

for (const target of [
  {
    service: 'resource-core',
    database: 'campus_core',
    user: 'core_app',
    other: 'campus_workflow',
    table: 'd_service_metadata',
  },
  {
    service: 'workflow',
    database: 'campus_workflow',
    user: 'workflow_app',
    other: 'campus_core',
    table: 'wf_service_metadata',
  },
]) {
  const config = parse(readFileSync(resolve(root, `apps/${target.service}/.env`), 'utf8'));
  assert.ok(config.DATABASE_URL, 'Local DATABASE_URL must exist');
  const source = new URL(config.DATABASE_URL);
  assert.equal(source.hostname, '127.0.0.1', 'This verifier is only for the local database');
  assert.equal(source.pathname, `/${target.database}`);
  const client = new Client({
    connectionString: source.href,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  try {
    await client.connect();
    const identity = (
      await client.query(
        'SELECT current_user AS username, current_database() AS database, version() AS version',
      )
    ).rows[0];
    assert.equal(identity.username, target.user);
    assert.equal(identity.database, target.database);
    const role = (
      await client.query(
        'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      )
    ).rows[0];
    assert.ok(
      Object.values(role).every((value) => value === false),
      'Application role must not hold elevated cluster privileges',
    );
    const connectPermission = (
      await client.query('SELECT has_database_privilege(current_user, $1, $2) AS allowed', [
        target.other,
        'CONNECT',
      ])
    ).rows[0];
    assert.equal(connectPermission.allowed, false);
    const tables = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    const snapshot = {
      service: target.service,
      database: identity.database,
      user: identity.username,
      tables,
    };
    if (empty) {
      assert.deepEqual(tables, [], 'First migration must start from an empty application schema');
    } else {
      const metadata = (
        await client.query(`SELECT key, value, "updatedAt" FROM ${target.table} ORDER BY key`)
      ).rows;
      assert.equal(metadata.length, 1);
      assert.equal(metadata[0].key, 'service-name');
      assert.equal(metadata[0].value, target.service);
      const migrations = (
        await client.query(
          'SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
        )
      ).rows;
      const expectedMigrations = readdirSync(
        resolve(root, `apps/${target.service}/prisma/migrations`),
      )
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
      assert.deepEqual(
        migrations.map((item) => item.migration_name),
        expectedMigrations,
      );
      for (const item of migrations) {
        const source = readFileSync(
          resolve(
            root,
            `apps/${target.service}/prisma/migrations/${item.migration_name}/migration.sql`,
          ),
        );
        assert.equal(
          createHash('sha256').update(source).digest('hex'),
          item.checksum,
          'An applied migration must not be edited',
        );
      }
      const failed = (
        await client.query(
          'SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL',
        )
      ).rows[0];
      assert.equal(failed.count, 0);
      snapshot.metadata = metadata;
      snapshot.migrations = migrations;
    }
    const crossDatabase = new URL(source);
    crossDatabase.pathname = `/${target.other}`;
    await mustReject(crossDatabase.href, '42501');
    const wrongPassword = new URL(source);
    wrongPassword.password = `incorrect-${randomBytes(24).toString('base64url')}`;
    await mustReject(wrongPassword.href, '28P01');
    results.push({
      ...snapshot,
      serverVersion: identity.version,
      crossDatabaseDenied: true,
      wrongPasswordDenied: true,
      elevatedClusterPrivileges: false,
    });
  } finally {
    await client.end();
  }
}
console.log(
  JSON.stringify({ status: 'passed', expectedEmpty: empty, databases: results }, null, 2),
);
