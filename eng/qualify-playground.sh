#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
pnpm run verify
node --test playground/investigation.test.mjs
