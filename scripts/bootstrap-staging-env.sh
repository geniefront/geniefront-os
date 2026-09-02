#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${GF_STAGING_ENV_SOURCE:-${ROOT}/.env}"
TARGET="${GF_STAGING_ENV_FILE:-${ROOT}/.env.staging}"
[[ -f "$SOURCE" ]] || { echo "✗ 缺少 ${SOURCE}（dev Supabase / Stripe test 来源）"; exit 1; }
[[ ! -e "$TARGET" ]] || { echo "✗ ${TARGET} 已存在，不会覆盖"; exit 1; }

get() { grep -E "^$1=" "$SOURCE" | tail -1 | cut -d= -f2- || true; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

{
  echo 'GF_ENV=staging'
  echo 'PORT=3000'
  echo 'LOG_LEVEL=info'
  echo 'API_HOST=staging-api.geniefront.com'
  echo 'DESK_HOST=staging-desk.geniefront.com'
  echo 'KIOSK_HOST=staging-kiosk.geniefront.com'
  echo 'PLATFORM_HOST=staging-ops.geniefront.com'
  echo 'MARKETING_HOST=staging.geniefront.com'
  echo 'MARKETING_WWW_HOST=staging-www.geniefront.com'
  echo 'BOOKING_HOST=staging-book.geniefront.com'
  echo 'APP_URL=https://staging-api.geniefront.com'
  echo 'VITE_API_BASE=https://staging-api.geniefront.com'
  echo 'APP_BASE_URL=https://staging-desk.geniefront.com'
  echo 'MARKETING_BASE_URL=https://staging.geniefront.com'
  echo 'FORM_BASE_URL=https://staging-desk.geniefront.com'
  echo 'PLATFORM_BASE_URL=https://staging-ops.geniefront.com'
  echo 'KIOSK_BASE_URL=https://staging-kiosk.geniefront.com'
  echo 'BOOKING_PAGE_ORIGIN=https://staging-book.geniefront.com'
  echo 'VITE_BOOKING_ORIGIN=https://staging-book.geniefront.com'
  echo 'BOOKING_MANAGE_PAGE_ENABLED='
  for key in APP_JWT_SECRET SUPABASE_URL SUPABASE_ANON_KEY DATABASE_URL \
    MIGRATION_DATABASE_URL APP_DB_PASSWORD STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY \
    STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ESSENTIAL STRIPE_PRICE_GROWTH \
    STRIPE_PRICE_AI_TOPUP FORM_ENCRYPTION_KEY; do
    echo "${key}=$(get "$key")"
  done
} > "$tmp"

install -m 0600 "$tmp" "$TARGET"
GF_ENV_FILE="$TARGET" "${ROOT}/scripts/env-guard.sh" staging
echo "✓ 已从现有 dev/test 配置生成 ${TARGET}（未复制生产短信、邮件或 Cloudflare 密钥）"
