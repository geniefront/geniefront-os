#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-status}"
cd "$ROOT"

case "$ACTION" in
  start)
    supabase start
    ;;
  stop)
    supabase stop
    ;;
  status)
    supabase status
    ;;
  setup)
    supabase start
    status_file=$(mktemp)
    trap 'rm -f "$status_file"' EXIT
    supabase status -o env > "$status_file"
    # Supabase CLI 生成的 env 输出只包含本机服务地址与本地开发密钥。
    set -a
    # shellcheck disable=SC1090
    source "$status_file"
    set +a

    [[ -n "${API_URL:-}" && -n "${ANON_KEY:-}" && -n "${SERVICE_ROLE_KEY:-}" && -n "${DB_URL:-}" ]] \
      || { echo "无法从 supabase status 读取本地连接信息"; exit 1; }

    if [[ -f .env.local ]]; then
      echo "✗ .env.local 已存在；为避免覆盖密钥，已停止。"
      exit 1
    fi

    jwt_secret=$(openssl rand -hex 48)
    form_key=$(openssl rand -hex 32)
    baseline_password=$(openssl rand -hex 24)
    stripe_value() {
      grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true
    }

    {
      echo 'GF_ENV=local'
      echo 'NODE_ENV=development'
      echo 'PORT=3000'
      echo 'APP_URL=http://127.0.0.1:3000'
      echo 'VITE_API_BASE=http://127.0.0.1:3000'
      echo 'APP_BASE_URL=http://127.0.0.1:5177'
      echo 'MARKETING_BASE_URL=http://127.0.0.1:5175'
      echo 'FORM_BASE_URL=http://127.0.0.1:5177'
      echo 'PLATFORM_BASE_URL=http://127.0.0.1:5176'
      echo 'KIOSK_BASE_URL=http://127.0.0.1:5178'
      echo 'BOOKING_PAGE_ORIGIN=http://127.0.0.1:5177'
      echo 'LOG_LEVEL=debug'
      echo "APP_JWT_SECRET=${jwt_secret}"
      echo "SUPABASE_URL=${API_URL}"
      echo "SUPABASE_ANON_KEY=${ANON_KEY}"
      echo "SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}"
      echo "MIGRATION_DATABASE_URL=${DB_URL}"
      echo 'APP_DB_PASSWORD=geniefront_local_only'
      echo 'DATABASE_URL=postgresql://app_user:geniefront_local_only@127.0.0.1:55322/postgres'
      for key in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET \
        STRIPE_PRICE_ESSENTIAL STRIPE_PRICE_GROWTH STRIPE_PRICE_AI_TOPUP; do
        echo "${key}=$(stripe_value "$key")"
      done
      echo "FORM_ENCRYPTION_KEY=${form_key}"
      echo "GF_BASELINE_PASSWORD=${baseline_password}"
      # 本机没有真实收件人：邮件与短信不出网，留在发件箱里，
      # 运营台「Test Inbox」那一页看（packages/db/sql/0082）
      echo 'COMMUNICATION_DELIVERY_MODE=capture'
      echo 'MAILPIT_URL=http://127.0.0.1:55324'
      echo 'STAGING_OTP_CODE=424242'
      echo 'STAGING_OTP_PHONES=+1617555*'
    } > .env.local
    chmod 600 .env.local

    APP_DB_PASSWORD=geniefront_local_only MIGRATION_DATABASE_URL="$DB_URL" \
      pnpm --filter @gf/db migrate
    "$ROOT/scripts/env-guard.sh" local
    echo "✓ 本地 Supabase 与 .env.local 已准备好"
    echo "  API：pnpm dev:api:local"
    echo "  Web：pnpm dev:web:local"
    ;;
  *)
    echo "用法：bash scripts/local-supabase.sh <setup|start|stop|status>"
    exit 2
    ;;
esac
