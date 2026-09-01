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
ENV_FILE="${ENV_FILE:-${ROOT}/.env}"
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
# ⚠️ warn 不计入 FAIL：这些配漏了脚本仍能跑通，但线上会静默出问题
#    （例如没有配置集时，退信永远不回流，而表现与一切正常完全相同）
warn() { echo "  ${Y}!${N} $1"; SKIP=$((SKIP+1)); }
note() { echo "  ${D}·${N} ${D}$1${N}"; }

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
  code=$(curl -g -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null)
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

# ─────────────────────────────────────────────────────────── 邮件
PROVIDER="$(printf '%s' "${EMAIL_PROVIDER:-resend}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
[[ "$PROVIDER" == "ses" ]] || PROVIDER="resend"   # 认不出的值回退 resend（与代码一致）
echo "${B}A4 · 邮件（供应商：${PROVIDER}）${N}"

if [[ "$PROVIDER" == "resend" ]]; then
  if check_format RESEND_API_KEY '^re_[A-Za-z0-9_-]{20,}$' \
    're_ 开头，后面约 30 字符'; then
    api_check "Resend API" -H "Authorization: Bearer ${RESEND_API_KEY}" \
      https://api.resend.com/domains
  fi
  # ⚠️ 没配 = POST /v1/webhooks/resend 一律 401 = 退信与投诉永远不回流，
  #    而现象与「一切正常」完全相同
  if [[ -z "${RESEND_WEBHOOK_SECRET:-}" ]]; then
    warn "RESEND_WEBHOOK_SECRET 未填 —— 投递回调会被一律拒收"
    hint "退信与投诉不会回流，抑制名单永远是空的，而这件事没有任何报错"
  fi
else
  check_format AWS_ACCESS_KEY_ID '^AKIA[A-Z0-9]{16}$' \
    'AKIA 开头，共 20 字符大写字母与数字'
  check_format AWS_SECRET_ACCESS_KEY '^.{40}$' \
    '40 字符（含 / 与 +，在 .env 里建议加引号）'

  # ⚠️⚠️ SES 的发件身份、抑制名单、配置集与发送配额**全部按区域独立**：区域填错时
  # 凭据合法、调用成功，只是那个区域里一个域名身份都没有 —— 现象是「所有邮件
  # 都被拒，而 AWS 控制台里域名全绿」。本项目 SES 侧的验证在 us-east-2。
  if check_format AWS_REGION '^[a-z]{2}-[a-z]+-[0-9]$' '形如 us-east-2'; then
    if [[ "$AWS_REGION" != "us-east-2" ]]; then
      warn "AWS_REGION=${AWS_REGION}，而本项目 SES 侧的域名验证在 us-east-2"
      hint "SES 的身份按区域独立。填错时不会报错，只会「所有邮件都被拒而域名全绿」"
    fi
  fi
  [[ -n "${SES_CONFIGURATION_SET:-}" ]] || {
    warn "SES_CONFIGURATION_SET 未填 —— 发出的邮件不会产生投递事件"
    hint "退信与投诉不会回流，抑制名单永远是空的，而这件事没有任何报错"; }
  [[ -n "${SES_SNS_TOPIC_ARN:-}" ]] || \
    warn "SES_SNS_TOPIC_ARN 未填 —— POST /v1/webhooks/ses 会一律拒收"

  # ⚠️ SES 账号长期处于沙箱时，只有已验证的收件地址能收到邮件。
  #    这条查不了（要签名调用），由 diagnose:comms 负责。
  note "SES 是否已脱离沙箱查不了：跑 pnpm diagnose:comms:staging"
fi

EMAIL_RE='^([^<]+<)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>?$'
for var in FROM_EMAIL CUSTOMER_FROM_EMAIL; do
  val="${!var:-}"
  if [[ "$var" == "CUSTOMER_FROM_EMAIL" && -z "$val" ]]; then
    warn "CUSTOMER_FROM_EMAIL 未填 —— 顾客邮件会回落到 FROM_EMAIL 的域"
    hint "两类邮件共用一个域时，账单与平台通知的投诉会拉低预约确认的送达率"
    continue
  fi
  if check_format "$var" "$EMAIL_RE" \
    '一个完整邮箱地址或 Display Name <email@domain.com>，域名必须已在当前供应商验证通过' \
    '店家事务用 notify. 子域，客户事务用 appointment. 子域'; then
    if [[ "$val" == *"@gmail.com" || "$val" == *"@qq.com" || "$val" == *"@163.com" ]]; then
      bad "$var 用了公共邮箱域名，发不出去"
      hint "必须用你自己的、已验证 DKIM 的域名"
    fi
  fi
done

# ⚠️ 2026-09-02 由 MARKETING_EMAIL_ROOT_DOMAIN 改名而来。旧值是根域
#    （geniefront.com），沿用它会从一个没验证的域发营销邮件，整批退信。
if [[ -n "${MARKETING_EMAIL_ROOT_DOMAIN:-}" ]]; then
  bad "MARKETING_EMAIL_ROOT_DOMAIN 已废弃，请改用 MARKETING_EMAIL_DOMAIN"
  hint "旧变量的值是根域；新变量是营销发件域本身（mkt.你的域名）"
fi
check_format MARKETING_EMAIL_DOMAIN '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' \
  '营销发件域本身，例如 mkt.geniefront.com'

note "发件域是否真的验证通过、以及投递回调通不通，跑 pnpm diagnose:comms:staging"
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

# ── Telnyx：号码 + 语音 + AI Assistant + 短信（03 决策 28，docs/09-TELNYX.md）──
if [[ -n "${TELNYX_API_KEY:-}" ]]; then
  if [[ "$TELNYX_API_KEY" == KEY* ]]; then
    api_check "Telnyx" -H "Authorization: Bearer ${TELNYX_API_KEY}" \
      "https://api.telnyx.com/v2/phone_numbers?page[size]=1"
  else
    # 只提示不判死：Telnyx 的 key 前缀是它自己定的，将来可能变。
    # 与其猜格式猜错把人挡在门外，不如直接打一次接口看能不能过
    echo "  ${Y}!${N} TELNYX_API_KEY 不是 KEY 开头 —— 确认拿的是 API Key 而不是 Public Key"
    api_check "Telnyx" -H "Authorization: Bearer ${TELNYX_API_KEY}" \
      "https://api.telnyx.com/v2/phone_numbers?page[size]=1"
  fi

  # ⚠️ 这一条是整条链路上唯一的安全要害：没有 public key 就无法验证
  # webhook 是不是真的来自 Telnyx，任何人都能伪造一条预约进复核队列
  if [[ -z "${TELNYX_PUBLIC_KEY:-}" ]]; then
    bad "TELNYX_API_KEY 填了但 TELNYX_PUBLIC_KEY 没填"
    hint "它是 webhook 的 Ed25519 验签公钥，不是调 API 的。缺了 = webhook 可被伪造（09 §3）"
  elif [[ "${TELNYX_PUBLIC_KEY}" == "${TELNYX_API_KEY}" ]]; then
    bad "TELNYX_PUBLIC_KEY 和 TELNYX_API_KEY 填成了同一个"
  fi

  [[ -n "${TELNYX_PHONE_NUMBER:-}" ]] && \
    check_format TELNYX_PHONE_NUMBER '^\+1[0-9]{10}$' 'E.164：+1 加 10 位数字' \
      '不要带空格、括号、短横，例如 +15125550142'
else
  skip "Telnyx 未填（Phase 2 才需要，见 docs/09-TELNYX.md）"
fi

# ── Twilio / Vapi：旧方案，过渡期保留。填了就顺手验一下，没填不提醒 ──────────
if [[ -n "${TWILIO_ACCOUNT_SID:-}" ]]; then
  if [[ "$TWILIO_ACCOUNT_SID" == SK* ]]; then
    bad "TWILIO_ACCOUNT_SID 拿成了 API Key SID（SK 开头）"; hint "要 AC 开头那个"
  elif check_format TWILIO_ACCOUNT_SID '^AC[0-9a-f]{32}$' 'AC + 32 位十六进制'; then
    [[ -n "${TWILIO_AUTH_TOKEN:-}" ]] && api_check "Twilio（旧方案）" \
      -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
      "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json"
  fi
fi

if [[ -n "${VAPI_API_KEY:-}" && -n "${VAPI_PUBLIC_KEY:-}" \
      && "$VAPI_API_KEY" == "$VAPI_PUBLIC_KEY" ]]; then
  bad "VAPI_API_KEY 和 VAPI_PUBLIC_KEY 填成了同一个"
fi

if [[ -n "${MARKETING_BASE_URL:-}" ]]; then
  if [[ "$MARKETING_BASE_URL" == *geniefront.app* ]]; then
    bad "MARKETING_BASE_URL 用了 .app —— 公开站是 geniefront.com"
  elif [[ "$MARKETING_BASE_URL" == *desk.geniefront.com* ]]; then
    bad "MARKETING_BASE_URL 填成了 desk —— 那是 APP_BASE_URL"
  elif [[ "$MARKETING_BASE_URL" =~ ^https?:// ]]; then
    ok "MARKETING_BASE_URL  ${D}${MARKETING_BASE_URL}${N}"
  else
    bad "MARKETING_BASE_URL 不是 http(s) URL"
  fi
else
  skip "MARKETING_BASE_URL 未填（apps/marketing Checkout 回跳需要）"
fi

if [[ -n "${APP_BASE_URL:-}" ]]; then
  if [[ "$APP_BASE_URL" == *geniefront.app* ]]; then
    bad "APP_BASE_URL 用了 .app —— desk 是 desk.geniefront.com"
  else
    ok "APP_BASE_URL  ${D}${APP_BASE_URL}${N}"
  fi
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
