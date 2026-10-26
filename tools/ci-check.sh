#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

for task_file in pnpm-lock.yaml infra/local/.env apps/resource-core/.env apps/workflow/.env apps/web/.env .local/demo-accounts.json; do
  if [[ ! -f "$task_file" ]]; then
    echo "Missing required project file: $task_file. Follow docs/development.md; this script does not initialize or replace configuration." >&2
    exit 1
  fi
done
if [[ ! -d node_modules ]]; then
  echo 'Missing project dependencies. Install the reviewed lockfile before running checks.' >&2
  exit 1
fi
if [[ "$(node --version)" != 'v24.22.0' || "$(pnpm --version)" != '10.33.4' ]]; then
  echo 'Use the pinned Node.js 24.22.0 and pnpm 10.33.4 toolchain.' >&2
  exit 1
fi

# Configuration, database readiness/migrations and seeds are prepared by the
# owner or the isolated CI job. Never init, install, pull, stop or erase here.
pnpm check
for task_suite in \
  test:database \
  test:identity:data \
  test:identity \
  test:scheduling \
  test:workflow \
  test:workorders \
  test:workflow:data \
  test:workorders:data \
  test:booking-lifecycle \
  test:admin-management; do
  pnpm "$task_suite"
done
