#!/usr/bin/env bash
# Production frontend assets for staging/production deploys.
#
# Vite `build --mode staging` still loads the repo-root `.env`. That file
# sets NODE_ENV=development, and Vite will copy it into process.env when
# the key is unset — producing a React development bundle (jsxDEV).
# Pin NODE_ENV=production in this process *before* any vite exec so the
# root .env cannot win.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
case "$MODE" in
  staging|production) ;;
  *) echo "用法：bash deploy/frontend-build.sh <staging|production>"; exit 2 ;;
esac

export NODE_ENV=production

node "${ROOT}/scripts/prepare-heroui.mjs"

APPS=(web ipad marketing platform booking)
for spec in "${APPS[@]}"; do
  echo "▸ NODE_ENV=${NODE_ENV} pnpm --filter @gf/${spec} exec vite build --mode ${MODE}"
  NODE_ENV=production pnpm --filter "@gf/${spec}" exec vite build --mode "$MODE" >/dev/null
done

# Markers that only appear in a React development client bundle.
PATTERN='jsxDEV|jsx-dev-runtime|react-dom\.development|react\.development'
fail=0
for spec in "${APPS[@]}"; do
  dist="${ROOT}/apps/${spec}/dist"
  if [[ ! -d "$dist" ]]; then
    echo "✗ missing ${dist}"
    fail=1
    continue
  fi
  hits=$(grep -RIlE "$PATTERN" "$dist" 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo "✗ @gf/${spec} dist contains a React development build:"
    echo "$hits" | sed 's/^/    /'
    fail=1
  else
    echo "✓ @gf/${spec} dist is a production React build"
  fi
done

if [[ $fail -ne 0 ]]; then
  echo "前端生产构建检查失败；拒绝继续部署。"
  exit 1
fi
