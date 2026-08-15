#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  检查 .env 里的凭据：先查格式，再真的调一次 API
#
#  用法：  bash scripts/check-env.sh
#          bash scripts/check-env.sh --format-only   # 只查格式，不联网
#
#  不会打印任何密钥的完整值，只显示前后几位用于核对。
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
FORMAT_ONLY=0
[[ "${1:-}" == "--format-only" ]] && FORMAT_ONLY=1

R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[34m'; D=$'\033[2m'; N=$'\033[0m'

PASS=0; FAIL=0; SKIP=0

if [[ ! -f "$ENV_FILE" ]]; then
  echo "${R}找不到 ${ENV_FILE}${N}"
  echo "先跑：  cp ${ROOT}/.env.example ${ROOT}/.env"
  exit 1
fi

# 只读取 KEY=VALUE 行，不 source（避免 .env 里的字符被 shell 解释）
while IFS='=' read -r k v; do
  [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  export "$k=$v"
done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$ENV_FILE")

mask() {  # 显示 前6…后4，用于核对是不是复制对了那一个
  local s="$1"
  if   [[ ${#s} -le 12 ]]; then printf '%s' "${s:0:2}…${s: -2}"
  else printf '%s…%s (%d字符)' "${s:0:6}" "${s: -4}" "${#s}"
  fi
}

ok()   { echo "  ${G}✓${N} $1"; PASS=$((PASS+1)); }
bad()  { echo "  ${R}✗${N} $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ${D}–${N} ${D}$1${N}"; SKIP=$((SKIP+1)); }
hint() { echo "      ${Y}→ $1${N}"; }

# check_format <var> <regex> <期望描述> <常见错误提示>
check_format() {
  local var="$1" re="$2" desc="$3" tip="${4:-}"
  local val="${!var:-}"
  if [[ -z "$val" ]]; then skip "${var} 未填"; return 1; fi
  if [[ "$val" =~ $re ]]; then
    ok "${var}  ${D}$(mask "$val")${N}"
    return 0
  else
    bad "${var} 格式不对  ${D}$(mask "$val")${N}"
    hint "应该是：${desc}"
    [[ -n "$tip" ]] && hint "${tip}"
    return 1
  fi
}

# api_check <label> <curl参数...>  —— 打印 HTTP 状态并判定
api_check() {
  local label="$1"; shift
  [[ $FORMAT_ONLY -eq 1 ]] && return 0
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null)
  case "$code" in
    2*) echo "      ${G}↳ ${label} 实测通过 (HTTP $code)${N}"; return 0 ;;
    000) echo "      ${Y}↳ ${label} 连不上（网络或超时）${N}"; return 1 ;;
    401|403) echo "      ${R}↳ ${label} 被拒绝 (HTTP $code) —— key 无效或权限不足${N}"; FAIL=$((FAIL+1)); PASS=$((PASS-1)); return 1 ;;
    *) echo "      ${Y}↳ ${label} 返回 HTTP $code${N}"; return 1 ;;
  esac
}

echo
echo "${B}═══ GenieFront OS · 凭据自检 ═══${N}"
[[ $FORMAT_ONLY -eq 1 ]] && echo "${D}（只查格式，不联网）${N}"
echo

# ─────────────────────────────────────────────────────────── 应用自身
echo "${B}应用自身${N}"
if [[ -z "${APP_JWT_SECRET:-}" ]]; then
  skip "APP_JWT_SECRET 未填"
  hint "生成一个：openssl rand -base64 48"
elif [[ ${#APP_JWT_SECRET} -lt 32 ]]; then
  bad "APP_JWT_SECRET 太短（${#APP_JWT_SECRET} 字符）"
  hint "至少 32 字符。生成：openssl rand -base64 48"
else
  ok "APP_JWT_SECRET  ${D}(${#APP_JWT_SECRET} 字符)${N}"
fi
echo

# ─────────────────────────────────────────────────────────── Supabase
echo "${B}A1 · Supabase${N}"
check_format SUPABASE_URL '^https://[a-z0-9]{20}\.supabase\.co$' \
  'https://<20个小写字母数字>.supabase.co' \
  '别用 dashboard 的网址，别带结尾斜杠'

# 先挡一道：拿错成 service_role / secret key 是这里最常见也最危险的错
anon_is_secret=0
if [[ "${SUPABASE_ANON_KEY:-}" == sb_secret_* ]]; then
  anon_is_secret=1
elif [[ "${SUPABASE_ANON_KEY:-}" == eyJ* ]]; then
  payload=$(echo "${SUPABASE_ANON_KEY}" | cut -d. -f2)
  pad=$(( (4 - ${#payload} % 4) % 4 ))
  decoded=$(printf '%s%*s' "$payload" $pad '' | tr ' ' '=' | tr '_-' '/+' | base64 -d 2>/dev/null || true)
  [[ "$decoded" == *service_role* ]] && anon_is_secret=1
fi

if [[ $anon_is_secret -eq 1 ]]; then
  bad "SUPABASE_ANON_KEY 实际是 service_role / secret key —— 拿错了，这个绝不能进 .env"
  hint "回 Project Settings → API，取 anon / public（或 sb_publishable_）那一个"
elif check_format SUPABASE_ANON_KEY '^(sb_publishable_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$' \
  'sb_publishable_… 或 eyJ… 开头的 JWT' \
  '别拿成 service_role / sb_secret_ 那个'; then
  # 用 /auth/v1/settings 验：/rest/v1/ 根路径只认 secret key，拿 publishable 去试会误报 401
  [[ -n "${SUPABASE_URL:-}" ]] && api_check "Supabase Auth" \
    -H "apikey: ${SUPABASE_ANON_KEY}" "${SUPABASE_URL}/auth/v1/settings"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  skip "DATABASE_URL 未填"
else
  db_ok=1
  if [[ "$DATABASE_URL" == *"[YOUR-PASSWORD]"* || "$DATABASE_URL" == *"YOUR-PASSWORD"* ]]; then
    bad "DATABASE_URL 里还留着 [YOUR-PASSWORD] 占位符没换"
    hint "换成你的数据库真实密码（Database → Reset database password 可以重设）"
    db_ok=0
  elif [[ "$DATABASE_URL" == *"://postgres."* ]]; then
    bad "DATABASE_URL 用的是 postgres 角色"
    hint "应用运行时必须用受限角色 app_user（没有 BYPASSRLS）"
    hint "postgres 角色的连接串填到 MIGRATION_DATABASE_URL"
    db_ok=0
  elif [[ ! "$DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
    bad "DATABASE_URL 不是 postgresql:// 开头"
    db_ok=0
  elif [[ "$DATABASE_URL" == *":5432/"* ]]; then
    bad "DATABASE_URL 用的是 5432（Session pooler）"
    hint "我们要 Transaction pooler，端口 6543 —— Connection string 页面切一下标签"
    db_ok=0
  elif [[ "$DATABASE_URL" != *":6543/"* ]]; then
    echo "  ${Y}!${N} DATABASE_URL 端口不是 6543，确认一下是不是 Transaction pooler"
  fi
  if [[ $db_ok -eq 1 ]]; then
    ok "DATABASE_URL  ${D}$(echo "$DATABASE_URL" | sed -E 's#://([^:]+):[^@]+@#://\1:****@#')${N}"
    # 密码里有未编码的特殊字符时提醒
    userpass="${DATABASE_URL#*://}"; userpass="${userpass%%@*}"
    if [[ "${userpass#*:}" =~ [/\#\?] ]]; then
      echo "      ${Y}↳ 密码里有 / # ? 之类的字符，需要 URL 编码（/ → %2F, # → %23, ? → %3F）${N}"
    fi
    if [[ $FORMAT_ONLY -eq 0 ]] && command -v psql >/dev/null 2>&1; then
      if psql "$DATABASE_URL" -c 'select 1' >/dev/null 2>&1; then
        echo "      ${G}↳ 数据库连接成功${N}"
      else
        echo "      ${R}↳ 数据库连不上 —— 密码或主机名不对${N}"; FAIL=$((FAIL+1)); PASS=$((PASS-1))
      fi
    fi
  fi
fi

if [[ -z "${MIGRATION_DATABASE_URL:-}" ]]; then
  skip "MIGRATION_DATABASE_URL 未填（跑迁移时需要）"
elif [[ "$MIGRATION_DATABASE_URL" != *"://postgres."* ]]; then
  bad "MIGRATION_DATABASE_URL 不是 postgres 角色"
  hint "迁移要建角色、开 RLS、装扩展，app_user 权限不够"
else
  ok "MIGRATION_DATABASE_URL  ${D}$(echo "$MIGRATION_DATABASE_URL" | sed -E 's#://([^:]+):[^@]+@#://\1:****@#')${N}"
fi

if [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  # 反向检查：这一把必须真的是 service_role，不能和 anon 填反了
  svc_role=""
  if [[ "$SUPABASE_SERVICE_ROLE_KEY" == sb_secret_* ]]; then
    svc_role="service_role"
  elif [[ "$SUPABASE_SERVICE_ROLE_KEY" == sb_publishable_* ]]; then
    svc_role="anon"
  elif [[ "$SUPABASE_SERVICE_ROLE_KEY" == eyJ* ]]; then
    payload=$(echo "${SUPABASE_SERVICE_ROLE_KEY}" | cut -d. -f2)
    pad=$(( (4 - ${#payload} % 4) % 4 ))
    decoded=$(printf '%s%*s' "$payload" $pad '' | tr ' ' '=' | tr '_-' '/+' | base64 -d 2>/dev/null || true)
    [[ "$decoded" == *service_role* ]] && svc_role="service_role"
    [[ "$decoded" == *'"anon"'* ]] && svc_role="anon"
  fi

  if [[ "$svc_role" == "anon" ]]; then
    bad "SUPABASE_SERVICE_ROLE_KEY 填成了 anon key —— 和上面那个填反了"
    hint "两个在 Settings → API 同一页上下挨着，看清楚再复制"
  elif [[ "$svc_role" == "service_role" ]]; then
    ok "SUPABASE_SERVICE_ROLE_KEY  ${D}$(mask "$SUPABASE_SERVICE_ROLE_KEY")${N}"
    if [[ "${NODE_ENV:-}" == "production" ]]; then
      bad "生产环境的 service_role key 落在了 .env 文件里"
      hint "生产的这一把只进 GitHub Actions Repository Secret，不进任何 .env"
    else
      echo "      ${D}↳ 仅供 packages/db 的迁移与种子脚本使用；apps/api 引用到它 CI 会失败${N}"
    fi
  else
    bad "SUPABASE_SERVICE_ROLE_KEY 格式无法识别  ${D}$(mask "$SUPABASE_SERVICE_ROLE_KEY")${N}"
    hint "应该是 sb_secret_… 或 eyJ… 开头的 JWT"
  fi
fi
echo

# ─────────────────────────────────────────────────────────── Anthropic
echo "${B}A2 · Anthropic${N}"
if [[ "${ANTHROPIC_API_KEY:-}" == sk-ant-admin* ]]; then
  bad "ANTHROPIC_API_KEY 是 Admin key，调不了模型"
  hint "回 Console → API Keys 建一个普通的（sk-ant-api03- 开头）"
elif check_format ANTHROPIC_API_KEY '^sk-ant-api03-[A-Za-z0-9_-]{80,}$' \
  'sk-ant-api03- 开头，总长约 108 字符' \
  'key 只在创建时显示一次，没存下来就重新建一个'; then
  api_check "Anthropic API" -H "x-api-key: ${ANTHROPIC_API_KEY}" \
    -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/models
fi
echo

# ─────────────────────────────────────────────────────────── Cloudflare
# DeepSeek 是可选备选，没填不算问题
if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  check_format DEEPSEEK_API_KEY '^sk-[a-f0-9]{32}$' 'sk- 开头 + 32 位十六进制' \
    && api_check "DeepSeek" -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" https://api.deepseek.com/models
fi
echo

echo "${B}A3 · Cloudflare${N}"
if [[ "${CLOUDFLARE_API_TOKEN:-}" =~ ^[0-9a-f]{37}$ ]]; then
  bad "CLOUDFLARE_API_TOKEN 拿成了 Global API Key（37 位十六进制）"
  hint "要的是 API Token：My Profile → API Tokens → Create Token"
  hint "权限勾 Zone→DNS→Edit 和 Account→Cloudflare Pages→Edit"
elif check_format CLOUDFLARE_API_TOKEN '^(cfat_[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40})$' \
  'cfat_ 开头的新格式，或 40 字符的旧格式' \
  '别拿 Global API Key（37 位纯十六进制）'; then
  # 用 zones 端点实测：/user/tokens/verify 不支持 cfat_ 这种账号级 token，
  # 拿它去验会误报 Invalid API Token
  api_check "Cloudflare Token" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/zones?per_page=1"
fi

check_format CLOUDFLARE_ACCOUNT_ID '^[0-9a-f]{32}$' '32 位十六进制' \
  '在任意域名 Overview 页右侧栏最下方那个'
check_format CLOUDFLARE_ZONE_ID '^[0-9a-f]{32}$' '32 位十六进制' \
  '在域名 Overview 页右侧栏，Account ID 上面那个'

if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_ZONE_ID:-}" \
      && "$CLOUDFLARE_ACCOUNT_ID" == "$CLOUDFLARE_ZONE_ID" ]]; then
  bad "ACCOUNT_ID 和 ZONE_ID 填成了同一个值 —— 这两个不一样"
  hint "Overview 页右侧栏：上面是 Zone ID，下面是 Account ID"
fi
echo

# ─────────────────────────────────────────────────────────── Resend
echo "${B}A4 · Resend${N}"
if check_format RESEND_API_KEY '^re_[A-Za-z0-9_-]{20,}$' \
  're_ 开头，后面约 30 字符'; then
  api_check "Resend API" -H "Authorization: Bearer ${RESEND_API_KEY}" \
    https://api.resend.com/domains
fi
if check_format FROM_EMAIL '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' \
  '一个完整邮箱地址，域名必须已在 Resend 验证通过' \
  '建议用子域：noreply@mail.你的域名'; then
  if [[ "$FROM_EMAIL" == *"@gmail.com" || "$FROM_EMAIL" == *"@qq.com" || "$FROM_EMAIL" == *"@163.com" ]]; then
    bad "FROM_EMAIL 用了公共邮箱域名，Resend 发不出去"
    hint "必须用你自己的、已验证 DKIM/SPF 的域名"
  fi
fi
echo

# ─────────────────────────────────────────────────────────── 后续阶段
if [[ -n "${YELP_API_KEY:-}" ]]; then
  api_check "Yelp Fusion" -H "Authorization: Bearer ${YELP_API_KEY}" \
    "https://api.yelp.com/v3/businesses/search?term=nail&location=11354&limit=1" \
    && ok "YELP_API_KEY  ${D}$(mask "$YELP_API_KEY")${N}"
else
  skip "YELP_API_KEY 未填（开店信息自动填充要用）"
fi

if [[ -n "${BRIGHT_DATA_API_KEY:-}" ]]; then
  api_check "Bright Data" -H "Authorization: Bearer ${BRIGHT_DATA_API_KEY}" \
    https://api.brightdata.com/datasets/list \
    && ok "BRIGHT_DATA_API_KEY  ${D}$(mask "$BRIGHT_DATA_API_KEY")${N}"
else
  skip "BRIGHT_DATA_API_KEY 未填（Phase 3 抓 Google 评价）"
fi
echo

echo "${B}B · Phase 1b（现在可留空）${N}"
if [[ -n "${UPSTASH_REDIS_URL:-}" ]]; then
  if [[ "$UPSTASH_REDIS_URL" == https://* ]]; then
    bad "UPSTASH_REDIS_URL 拿成了 REST API 地址"
    hint "BullMQ 用 Redis 协议，要 rediss:// 开头那条"
    hint "在 Upstash 控制台切到 Redis / Connect 标签页复制"
  else
    check_format UPSTASH_REDIS_URL '^rediss?://.+@.+:[0-9]+$' \
      'rediss://default:<密码>@<host>.upstash.io:6379'
  fi
else
  skip "UPSTASH_REDIS_URL 未填（Phase 1b 才需要）"
fi
echo

echo "${B}C · Phase 2（现在可留空）${N}"
if [[ -n "${TWILIO_ACCOUNT_SID:-}" ]]; then
  if [[ "$TWILIO_ACCOUNT_SID" == SK* ]]; then
    bad "TWILIO_ACCOUNT_SID 拿成了 API Key SID（SK 开头）"; hint "要 AC 开头那个"
  elif [[ "$TWILIO_ACCOUNT_SID" == MG* ]]; then
    bad "TWILIO_ACCOUNT_SID 拿成了 Messaging Service SID（MG 开头）"; hint "要 AC 开头那个"
  elif check_format TWILIO_ACCOUNT_SID '^AC[0-9a-f]{32}$' 'AC + 32 位十六进制'; then
    [[ -n "${TWILIO_AUTH_TOKEN:-}" ]] && api_check "Twilio" \
      -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
      "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json"
  fi
  check_format TWILIO_PHONE_NUMBER '^\+1[0-9]{10}$' 'E.164：+1 加 10 位数字' \
    '不要带空格、括号、短横，例如 +15125550142'
else
  skip "Twilio 未填（Phase 2 才需要）"
fi

if [[ -n "${VAPI_API_KEY:-}" && -n "${VAPI_PUBLIC_KEY:-}" \
      && "$VAPI_API_KEY" == "$VAPI_PUBLIC_KEY" ]]; then
  bad "VAPI_API_KEY 和 VAPI_PUBLIC_KEY 填成了同一个"
fi

if [[ -n "${STRIPE_SECRET_KEY:-}" ]]; then
  if [[ "$STRIPE_SECRET_KEY" == sk_live_* ]]; then
    echo "  ${Y}!${N} ${Y}STRIPE_SECRET_KEY 是 live key —— 开发环境请用 sk_test_${N}"
  elif [[ "$STRIPE_SECRET_KEY" == rk_* ]]; then
    bad "STRIPE_SECRET_KEY 是 Restricted key（rk_），权限不够建订阅"
  elif check_format STRIPE_SECRET_KEY '^sk_test_[A-Za-z0-9]{50,}$' 'sk_test_ 开头，约 107 字符'; then
    api_check "Stripe" -u "${STRIPE_SECRET_KEY}:" https://api.stripe.com/v1/balance
  fi
else
  skip "Stripe 未填（Phase 2 才需要）"
fi

if [[ -n "${TURNSTILE_SITE_KEY:-}" && -n "${TURNSTILE_SECRET_KEY:-}" ]]; then
  if [[ ${#TURNSTILE_SITE_KEY} -gt ${#TURNSTILE_SECRET_KEY} ]]; then
    bad "Turnstile 的 SITE_KEY 比 SECRET_KEY 还长 —— 大概率填反了"
    hint "Secret key 明显更长，Site key 更短"
  fi
fi
echo

# ─────────────────────────────────────────────────────────── 汇总
echo "${B}═══════════════════════════════${N}"
echo "  通过 ${G}${PASS}${N}   失败 ${R}${FAIL}${N}   未填 ${D}${SKIP}${N}"
if [[ $FAIL -gt 0 ]]; then
  echo
  echo "${R}有 ${FAIL} 项需要修 —— 上面每条都写了应该长什么样。${N}"
  exit 1
fi
echo
echo "${G}没有问题。${N}"
