#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
case "$TARGET" in
  staging|production) ;;
  *) echo "用法：bash scripts/migrate-env.sh <staging|production>"; exit 2 ;;
esac

ENV_FILE="${ROOT}/.env.${TARGET}"
"${ROOT}/scripts/env-guard.sh" "$TARGET"
grep -q '^MIGRATION_DATABASE_URL=.' "$ENV_FILE" || { echo "✗ MIGRATION_DATABASE_URL 未配置"; exit 1; }
grep -q '^APP_DB_PASSWORD=.' "$ENV_FILE" || { echo "✗ APP_DB_PASSWORD 未配置"; exit 1; }

if [[ "$TARGET" == production && "${GF_CONFIRM_PRODUCTION:-}" != "deploy-production" ]]; then
  echo "✗ 生产迁移需要显式确认：GF_CONFIRM_PRODUCTION=deploy-production pnpm migrate:production"
  exit 1
fi

exec "${ROOT}/scripts/run-env.sh" "$TARGET" pnpm --filter @gf/db migrate
