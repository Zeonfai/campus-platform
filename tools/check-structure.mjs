import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const spec = JSON.parse(read('packages/contracts/openapi.json'));
const ids = new Set();
let operationCount = 0;
let implementedCount = 0;
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    assert.ok(!ids.has(operation.operationId), `Duplicate operationId ${operation.operationId}`);
    ids.add(operation.operationId);
    assert.ok(['scaffold', 'implemented'].includes(operation['x-implementation']));
    if (operation['x-implementation'] === 'scaffold') assert.ok(operation.responses['501']);
    else implementedCount++;
    if (path.startsWith('/internal/'))
      assert.deepEqual(operation.security, [{ serviceBearer: [] }]);
    const module = operation.tags[0].toLowerCase();
    const service = operation['x-service'];
    const controller = read(`apps/${service}/src/modules/${module}/${module}.controller.ts`);
    const route = path.slice(1).replace(/\{([^}]+)\}/g, ':$1');
    const decorator = method[0].toUpperCase() + method.slice(1);
    assert.ok(controller.includes(`@${decorator}('${route}')`), `Missing route ${method} ${path}`);
    if (operation['x-implementation'] === 'scaffold')
      assert.ok(controller.includes(`${operation.operationId}(): never`));
    else assert.ok(controller.includes(`${operation.operationId}(`));
    operationCount++;
  }
}
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if ('$ref' in value) {
    assert.ok(value.$ref.startsWith('#/'));
    let target = spec;
    for (const part of value.$ref.slice(2).split('/')) target = target?.[part];
    assert.notEqual(target, undefined, `Unresolved ${value.$ref}`);
  }
  for (const item of Object.values(value)) visit(item);
}
visit(spec);
const packageDirs = [
  '.',
  ...['apps', 'packages'].flatMap((dir) =>
    readdirSync(resolve(root, dir)).map((name) => `${dir}/${name}`),
  ),
];
const packages = new Map(
  packageDirs.map((dir) => {
    const item = JSON.parse(read(`${dir}/package.json`));
    return [item.name, item];
  }),
);
for (const item of packages.values()) {
  assert.equal(item.private, true);
  for (const [name, version] of Object.entries({ ...item.dependencies, ...item.devDependencies })) {
    if (version === 'workspace:*') assert.ok(packages.has(name));
    else
      assert.match(
        version,
        /^\d+\.\d+\.\d+$/,
        `Dependency must use a stable exact version: ${name}`,
      );
  }
}
assert.equal(packages.get('campus-platform').packageManager, 'pnpm@10.33.4');
for (const service of ['resource-core', 'workflow']) {
  assert.ok(
    existsSync(
      resolve(
        root,
        `apps/${service}/prisma/migrations/20261015000100_infrastructure_baseline/migration.sql`,
      ),
    ),
  );
}
console.log(
  `Structure OK: ${packages.size} packages, ${operationCount} operations (${implementedCount} implemented, ${operationCount - implementedCount} scaffold), all schema references and controller routes resolved.`,
);
