import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireCore = createRequire(new URL('../apps/resource-core/package.json', import.meta.url));
const { parse } = requireCore('dotenv');
const core = parse(readFileSync(resolve(root, 'apps/resource-core/.env'), 'utf8'));
const workflow = parse(readFileSync(resolve(root, 'apps/workflow/.env'), 'utf8'));
for (const config of [core, workflow]) {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? config.NODE_ENV ?? 'development'))
    throw new Error('The local development launcher cannot run in production');
  if (!['127.0.0.1', 'localhost'].includes(config.HOST ?? '127.0.0.1'))
    throw new Error('The local development launcher requires loopback service hosts');
  if (!config.DATABASE_URL || new URL(config.DATABASE_URL).hostname !== '127.0.0.1')
    throw new Error('The local development launcher requires existing local databases');
}
const coreToken = process.env.M2_SERVICE_TOKEN ?? core.M2_SERVICE_TOKEN;
const workflowToken = process.env.M2_SERVICE_TOKEN ?? workflow.M2_SERVICE_TOKEN;
if (coreToken !== workflowToken)
  throw new Error(
    'Existing M2 service credentials disagree; review configuration without printing values',
  );
const serviceToken = coreToken ?? randomBytes(32).toString('base64url');
if (!/^[A-Za-z0-9_-]{32,200}$/.test(serviceToken))
  throw new Error('Invalid M2 service credential format');
const coreM3Token = process.env.M3_SERVICE_TOKEN ?? core.M3_SERVICE_TOKEN;
const workflowM3Token = process.env.M3_SERVICE_TOKEN ?? workflow.M3_SERVICE_TOKEN;
if (coreM3Token !== workflowM3Token)
  throw new Error('Existing M3 service credentials disagree; review without printing values');
const m3Token = coreM3Token ?? randomBytes(32).toString('base64url');
if (!/^[A-Za-z0-9_-]{32,200}$/.test(m3Token) || m3Token === serviceToken)
  throw new Error('M3 service identity must be valid and distinct from M2');
const configuredOrigin = process.env.RESOURCE_CORE_URL ?? workflow.RESOURCE_CORE_URL;
const resourceOrigin = configuredOrigin ?? `http://127.0.0.1:${core.PORT ?? '3001'}`;
const origin = new URL(resourceOrigin);
if (
  !['127.0.0.1', 'localhost'].includes(origin.hostname) ||
  origin.protocol !== 'http:' ||
  origin.origin !== resourceOrigin
)
  throw new Error('Local workflow must target the local core HTTP origin');
console.log(
  'Starting local apps with a process-only M2/M3 identities; no environment files or credentials are written.',
);
const child = spawn('pnpm', ['--parallel', '--filter', './apps/*', 'run', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    M2_SERVICE_TOKEN: serviceToken,
    M3_SERVICE_TOKEN: m3Token,
    RESOURCE_CORE_URL: resourceOrigin,
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('Local app launcher failed; run with the project pnpm tool in WSL.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
