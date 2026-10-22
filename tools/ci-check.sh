#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f pnpm-lock.yaml ]]; then
  echo 'Missing pnpm-lock.yaml: complete the initial authorized install and review the lockfile first.' >&2
  exit 1
fi
pnpm install --frozen-lockfile
pnpm check
