#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
case "$TARGET" in
  local|staging|production) ;;
  *) echo "用法：bash scripts/env-guard.sh <local|staging|production>"; exit 2 ;;
esac

ENV_FILE="${ROOT}/.env.${TARGET}"
[[ -f "$ENV_FILE" ]] || { echo "✗ 缺少 ${ENV_FILE}"; exit 1; }

get() {
  local key="$1" line
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

fail=0
bad() { echo "  ✗ $*"; fail=1; }
ok() { echo "  ✓ $*"; }
require() { [[ -n "$(get "$1")" ]] || bad "$1 未配置"; }

check_stripe_price() {
  local label="$1" price_id="$2" expected_amount="$3" expected_livemode="$4"
  local payload actual_id active livemode currency unit_amount interval

  command -v curl >/dev/null 2>&1 || { bad "缺少 curl，无法校验 Stripe ${label} 价格"; return; }
  command -v jq >/dev/null 2>&1 || { bad "缺少 jq，无法校验 Stripe ${label} 价格"; return; }

  if ! payload=$(curl --fail --silent --show-error --max-time 15 \
    -u "${stripe_secret}:" "https://api.stripe.com/v1/prices/${price_id}"); then
    bad "Stripe ${label} 价格无法通过当前环境密钥读取"
    return
  fi

  actual_id=$(jq -r '.id // empty' <<<"$payload")
  active=$(jq -r '.active // false' <<<"$payload")
  livemode=$(jq -r '.livemode // false' <<<"$payload")
  currency=$(jq -r '.currency // empty' <<<"$payload")
  unit_amount=$(jq -r '.unit_amount // empty' <<<"$payload")
  interval=$(jq -r '.recurring.interval // empty' <<<"$payload")

  [[ "$actual_id" == "$price_id" ]] || bad "Stripe ${label} 返回了非预期价格对象"
  [[ "$active" == "true" ]] || bad "Stripe ${label} 价格必须处于启用状态"
  [[ "$livemode" == "$expected_livemode" ]] || bad "Stripe ${label} 价格模式与 ${TARGET} 环境不一致"
  [[ "$currency" == "usd" ]] || bad "Stripe ${label} 价格币种必须为 USD"
  [[ "$unit_amount" == "$expected_amount" ]] || bad "Stripe ${label} 价格金额配置错误"
  [[ "$interval" == "month" ]] || bad "Stripe ${label} 必须是月度订阅价格"
}

echo "检查 ${TARGET} 环境：${ENV_FILE}"
[[ "$(get GF_ENV)" == "$TARGET" ]] || bad "GF_ENV 必须是 ${TARGET}"
for key in APP_JWT_SECRET SUPABASE_URL SUPABASE_ANON_KEY DATABASE_URL \
  APP_URL VITE_API_BASE APP_BASE_URL STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY \
  STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ESSENTIAL STRIPE_PRICE_GROWTH FORM_ENCRYPTION_KEY; do
  require "$key"
done

stripe_secret=$(get STRIPE_SECRET_KEY)
stripe_public=$(get STRIPE_PUBLISHABLE_KEY)
supabase_url=$(get SUPABASE_URL)
database_url=$(get DATABASE_URL)
app_url=$(get APP_URL)
app_base=$(get APP_BASE_URL)
api_base=$(get VITE_API_BASE)

case "$TARGET" in
  local)
    [[ "$supabase_url" == http://127.0.0.1:55321 || "$supabase_url" == http://localhost:55321 ]] \
      || bad "local 必须使用 GenieFront 本机 Supabase（127.0.0.1:55321）"
    [[ "$database_url" == *"127.0.0.1:55322"* || "$database_url" == *"localhost:55322"* ]] \
      || bad "local DATABASE_URL 必须指向本机 55322"
    [[ "$stripe_secret" == sk_test_* && "$stripe_public" == pk_test_* ]] \
      || bad "local 必须使用 Stripe test keys"
    [[ "$app_url" == http://127.0.0.1:* || "$app_url" == http://localhost:* ]] \
      || bad "local APP_URL 必须是 localhost/127.0.0.1"
    ;;
  staging)
    [[ "$supabase_url" == https://*.supabase.co ]] || bad "staging 必须使用托管的 dev/staging Supabase"
    [[ "$database_url" != *"127.0.0.1"* && "$database_url" != *"localhost"* ]] \
      || bad "staging DATABASE_URL 不能指向本机"
    [[ "$stripe_secret" == sk_test_* && "$stripe_public" == pk_test_* ]] \
      || bad "staging 必须使用 Stripe test keys"
    [[ "$app_url" == *staging* && "$app_base" == *staging* && "$api_base" == *staging* ]] \
      || bad "staging 的公开 URL 必须使用 staging 域名"
    # 邮件里的 logo / 退订页 / 填表按钮走这三条，漏检就会把 localhost 发出去
    for key in MARKETING_BASE_URL FORM_BASE_URL BOOKING_PAGE_ORIGIN APP_URL APP_BASE_URL VITE_API_BASE; do
      val="$(get "$key")"
      [[ "$val" != *localhost* && "$val" != *127.0.0.1* ]] \
        || bad "${key} 不能指向本机（会写进客人邮件且无法撤回）"
      [[ "$val" == https://* ]] || bad "${key} 必须是 https"
      [[ "$val" == *staging* ]] || bad "${key} 必须使用 staging 域名"
    done
    # 固定验证码没有白名单等于「任何号码都能用一个常量登录」，
    # 而 staging 上是有真实店主数据的
    if [[ -n "$(get STAGING_OTP_CODE)" ]]; then
      [[ -n "$(get STAGING_OTP_PHONES)" ]] \
        || bad "配了 STAGING_OTP_CODE 就必须配 STAGING_OTP_PHONES 白名单"
      [[ "$(get STAGING_OTP_CODE)" =~ ^[0-9]{4,8}$ ]] || bad "STAGING_OTP_CODE 必须是 4–8 位数字"
    fi
    if [[ -f "${ROOT}/.env.production" ]]; then
      prod_sb=$(ENV_FILE="${ROOT}/.env.production"; grep '^SUPABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
      prod_db=$(ENV_FILE="${ROOT}/.env.production"; grep '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
      [[ -z "$prod_sb" || "$supabase_url" != "$prod_sb" ]] || bad "staging 与 production 使用了同一个 Supabase 项目"
      [[ -z "$prod_db" || "$database_url" != "$prod_db" ]] || bad "staging 与 production 使用了同一个数据库"
    fi
    ;;
  production)
    # 🔴 通信测试开关一旦漏进生产就是**静默故障**：capture 会把所有确认信、
    # 收据、提醒吞掉而不报错；固定 OTP 等于人人可上机。应用启动时也拦
    # （apps/api/src/comms/mode.ts 的 assertCommunicationSafety），
    # 但这里要更早拦下 —— 到那一步已经在往生产推了。
    for key in STAGING_OTP_CODE STAGING_OTP_PHONES MAILPIT_URL; do
      [[ -z "$(get "$key")" ]] || bad "production 不允许配置 ${key}（只属于 local/staging）"
    done
    delivery=$(get COMMUNICATION_DELIVERY_MODE)
    [[ "$delivery" != "capture" ]] || bad "production 的 COMMUNICATION_DELIVERY_MODE 不能是 capture"
    [[ "$supabase_url" == https://*.supabase.co ]] || bad "production 必须使用托管 Supabase"
    [[ "$stripe_secret" == sk_live_* && "$stripe_public" == pk_live_* ]] \
      || bad "production 必须使用 Stripe live keys"
    [[ "$app_url" == https://api.geniefront.com ]] || bad "production APP_URL 必须是 https://api.geniefront.com"
    [[ "$app_base" == https://desk.geniefront.com ]] || bad "production APP_BASE_URL 必须是 https://desk.geniefront.com"
    [[ "$api_base" == https://api.geniefront.com ]] || bad "production VITE_API_BASE 必须是 https://api.geniefront.com"
    [[ "$(get MARKETING_BASE_URL)" == https://www.geniefront.com || "$(get MARKETING_BASE_URL)" == https://geniefront.com ]] \
      || bad "production MARKETING_BASE_URL 必须是 https://www.geniefront.com 或 https://geniefront.com（邮件 logo 与页脚）"
    [[ "$(get FORM_BASE_URL)" == https://desk.geniefront.com ]] \
      || bad "production FORM_BASE_URL 必须是 https://desk.geniefront.com"
    [[ "$(get BOOKING_PAGE_ORIGIN)" == https://book.geniefront.com ]] \
      || bad "production BOOKING_PAGE_ORIGIN 必须是 https://book.geniefront.com"
    for key in MARKETING_BASE_URL FORM_BASE_URL BOOKING_PAGE_ORIGIN APP_URL APP_BASE_URL; do
      val="$(get "$key")"
      [[ "$val" != *localhost* && "$val" != *127.0.0.1* ]] \
        || bad "${key} 不能指向本机"
    done
    if [[ -f "${ROOT}/.env.staging" ]]; then
      stage_sb=$(grep '^SUPABASE_URL=' "${ROOT}/.env.staging" | tail -1 | cut -d= -f2-)
      stage_db=$(grep '^DATABASE_URL=' "${ROOT}/.env.staging" | tail -1 | cut -d= -f2-)
      [[ -z "$stage_sb" || "$supabase_url" != "$stage_sb" ]] || bad "production 与 staging 使用了同一个 Supabase 项目"
      [[ -z "$stage_db" || "$database_url" != "$stage_db" ]] || bad "production 与 staging 使用了同一个数据库"
    fi
    ;;
esac

if [[ "$TARGET" == "staging" || "$TARGET" == "production" ]]; then
  expected_livemode=false
  [[ "$TARGET" == "production" ]] && expected_livemode=true
  check_stripe_price "Essential" "$(get STRIPE_PRICE_ESSENTIAL)" 9900 "$expected_livemode"
  check_stripe_price "Growth" "$(get STRIPE_PRICE_GROWTH)" 19900 "$expected_livemode"
fi

if [[ $fail -ne 0 ]]; then
  echo "环境检查失败；没有执行任何部署或数据库操作。"
  exit 1
fi
ok "${TARGET} 环境边界检查通过"
