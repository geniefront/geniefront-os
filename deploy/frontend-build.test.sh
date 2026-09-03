#!/usr/bin/env bash
# Regression: deploy frontend builds stay on NODE_ENV=production even when
# the parent shell / root .env say development.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
pass() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }

deploy="${ROOT}/deploy/deploy.sh"
builder="${ROOT}/deploy/frontend-build.sh"

grep -q 'frontend-build.sh' "$deploy" \
  && pass "deploy.sh invokes deploy/frontend-build.sh" \
  || bad "deploy.sh does not call deploy/frontend-build.sh"

grep -q 'export NODE_ENV=production' "$builder" \
  && pass "frontend-build.sh exports NODE_ENV=production" \
  || bad "frontend-build.sh missing export NODE_ENV=production"

if grep -E 'pnpm --filter @gf/(web|ipad|marketing|platform|booking) exec vite build' "$deploy" \
     | grep -v NODE_ENV >/dev/null; then
  # Bare vite builds in deploy.sh would reintroduce the leak.
  if grep -q 'frontend-build.sh' "$deploy" \
     && ! grep -E '^\s*pnpm --filter @gf/.*exec vite build' "$deploy"; then
    pass "deploy.sh has no unguarded vite build lines"
  else
    bad "deploy.sh still runs unguarded vite build"
  fi
else
  pass "deploy.sh has no unguarded vite build lines"
fi

# Parent env is development (same leak as sourcing root .env).
echo "  · NODE_ENV=development bash deploy/frontend-build.sh staging"
if NODE_ENV=development bash "$builder" staging; then
  pass "frontend-build.sh succeeds under a development parent env"
else
  bad "frontend-build.sh failed under NODE_ENV=development"
fi

if [[ $fail -ne 0 ]]; then
  echo "✗ deploy frontend production-build guard"
  exit 1
fi
echo "✓ deploy frontend production-build guard"
