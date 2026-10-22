import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = [
  'infra/local/.env',
  'apps/resource-core/.env',
  'apps/workflow/.env',
  'apps/web/.env',
];
if (targets.some((name) => existsSync(resolve(root, name)))) {
  throw new Error(
    'Local environment files already exist; refusing to overwrite or rotate credentials.',
  );
}
const passwords = {
  admin: randomBytes(24).toString('base64url'),
  core: randomBytes(24).toString('base64url'),
  workflow: randomBytes(24).toString('base64url'),
};
const contents = {
  'infra/local/.env': `POSTGRES_PORT=15432\nPOSTGRES_ADMIN_PASSWORD=${passwords.admin}\nCORE_DB_PASSWORD=${passwords.core}\nWORKFLOW_DB_PASSWORD=${passwords.workflow}\n`,
  'apps/resource-core/.env': readFileSync(
    resolve(root, 'apps/resource-core/.env.example'),
    'utf8',
  ).replace('REPLACE_WITH_LOCAL_PASSWORD@127.0.0.1:5432', `${passwords.core}@127.0.0.1:15432`),
  'apps/workflow/.env': readFileSync(resolve(root, 'apps/workflow/.env.example'), 'utf8').replace(
    'REPLACE_WITH_LOCAL_PASSWORD@127.0.0.1:5432',
    `${passwords.workflow}@127.0.0.1:15432`,
  ),
  'apps/web/.env': readFileSync(resolve(root, 'apps/web/.env.example'), 'utf8'),
};
for (const name of targets)
  writeFileSync(resolve(root, name), contents[name], { flag: 'wx', mode: 0o600 });
console.log(
  'Created four ignored local environment files with independent database passwords; no service was started.',
);
