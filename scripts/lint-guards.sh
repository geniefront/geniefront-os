#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  宪法的可执行部分。这几条靠人自觉守不住，所以进 CI。
#
#  用法：bash scripts/lint-guards.sh   （pnpm lint:guards）
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'
FAIL=0

report() {  # report <标题> <宪法条款> <说明> <命中内容>
  echo "${R}✗ $1${N}"
  echo "  ${D}$2${N}"
  echo "  $3"
  echo "$4" | sed 's/^/    /'
  FAIL=1
}

# ⚠️ 必须排掉 node_modules / 构建产物。
# 不排的话 Vite 的依赖预打包（apps/*/node_modules/.vite/deps/*.js）会被扫进来，
# 而 recharts 里一句 `Number(activeTooltipIndex)` 会被当成「金额走了浮点解析」——
# 一条谁也修不了的红线，最后的结果是大家开始忽略这个脚本。
SRC='--include=*.ts --include=*.tsx --include=*.js
     --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.vite'

# ── 1. service_role 只有 packages/db 能碰 ────────────────────────────────────
# 业务查询一旦走 service_role，RLS 被静默绕过，所有租户隔离测试会
# 全部通过但毫无意义，直到线上串了数据才发现。
hits=$(grep -rn $SRC 'SUPABASE_SERVICE_ROLE_KEY' apps/ 2>/dev/null || true)
[[ -n "$hits" ]] && report \
  "apps/ 里引用了 SUPABASE_SERVICE_ROLE_KEY" \
  "宪法第 5 条：service_role 只有 packages/db 的迁移与种子脚本可以读" \
  "把这段逻辑改走命令总线 + withTenant()，或挪进 packages/db。" \
  "$hits"

# ── 1b. apps/ 不许碰 admin 连接（postgres 角色，不受 RLS） ───────────────────
hits=$(grep -rn $SRC -E "from ['\"].*db/(src/)?admin|MIGRATION_DATABASE_URL|unsafeAdminQuery" apps/ 2>/dev/null || true)
[[ -n "$hits" ]] && report \
  "apps/ 里用了迁移专用的 admin 连接" \
  "宪法第 5 条：业务读写一律走 withTenant()" \
  "admin 连接用的是 postgres 角色，不受 RLS 约束 —— 那是给迁移和种子脚本的。" \
  "$hits"

# ── 2. 裸 SET 会泄漏到下一个租户的请求 ───────────────────────────────────────
# Supavisor transaction mode 下连接是复用的：SET 是会话级，
# 上一个请求设的 app.org_id 会被下一个请求继承 —— 静默串租户。
hits=$(grep -rn $SRC -iE "\bset[[:space:]]+app\.[a-z_]+" apps/ packages/ 2>/dev/null \
       | grep -viE "set[[:space:]]+local[[:space:]]+app\.|set_config" || true)
[[ -n "$hits" ]] && report \
  "用了裸 SET 而不是 SET LOCAL" \
  "宪法第 5 条：永远不用裸 SET" \
  "改成 set_config(..., true) 或 SET LOCAL —— 必须在事务内。" \
  "$hits"

# ── 3. 不许给 membership 建排他约束 ─────────────────────────────────────────
# 决策 17 默认允许超卖。DB 级硬拒绝会在上线第一天炸掉，
# 而且前台看不懂 "23P01 conflicting key value violates exclusion constraint"。
hits=$(grep -rn --include=*.sql -iE "exclude[[:space:]]+using[[:space:]]+gist" packages/db/sql/ 2>/dev/null \
       | grep -i "membership" || true)
[[ -n "$hits" ]] && report \
  "给 membership_id 建了排他约束" \
  "宪法第 15 条：约束分层，永不给 membership 建排他约束" \
  "技师并发是软约束，在应用层查 max_concurrent_appointments，超出写 overbooked + reason。" \
  "$hits"

# ── 4. 钱不许用浮点 ─────────────────────────────────────────────────────────
# 小费分配涉及钱，0.1+0.2 的误差会被技师发现并投诉。
hits=$(grep -rn $SRC -E "(parseFloat|Number)\([^)]*(cents|amount|price|tip|total)" \
       apps/ packages/ 2>/dev/null || true)
[[ -n "$hits" ]] && report \
  "金额字段走了浮点解析" \
  "宪法第 4 条：金额只用整数分，百分比只用 basis point" \
  "用 parseInt / BigInt，或直接让 Zod 的 z.number().int() 把关。" \
  "$hits"

# ── 5. 审计不许记金额 ───────────────────────────────────────────────────────
hits=$(grep -rn $SRC -E "auditRedact" packages/contracts/src/commands/ 2>/dev/null || true)
tickets=$(grep -rln $SRC "ticket" packages/contracts/src/commands/ 2>/dev/null || true)
if [[ -n "$tickets" && -z "$hits" ]]; then
  echo "${Y}! ticket 相关命令还没声明 auditRedact${N}"
  echo "  ${D}宪法第 17 条：ticket / payment 的金额字段不写入 audit_log${N}"
fi

# ── 6. 界面文案必须走多语言字典 ─────────────────────────────────────────────
# 审核前的状态：字典有 1017 个词条，代码里另有约 3600 行中文字面量，
# 两者从未对齐，且没有任何机制能在改动时发现。人工约定在此规模下不成立。
# 判定基于 TypeScript AST，中文注释与业务标识不会被误判。
if command -v node >/dev/null 2>&1; then
  hits=$(node scripts/i18n-guard.mjs 2>&1 || true)
  if [[ -n "$hits" ]]; then
    report \
      "界面文案未走多语言字典" \
      "宪法第 18 条：界面文案一律经 t() 取用，不得写死在页面中" \
      "用 node scripts/i18n-extract.mjs plan 生成抽取方案，复核译文后 apply。" \
      "$hits"
  fi
fi

# ── 7. 经营页面与查询层不许静默注入演示记录 ─────────────────────────────────
# 销售演示应使用隔离的 demo tenant。生产组件在空数据时只能返回空集合、零值或
# 明确错误，不能用看似真实的姓名、电话、银行批次和经营指标填满页面。
if command -v rg >/dev/null 2>&1; then
  hits=$(rg -n \
    --glob '!*.test.ts' --glob '!*.test.tsx' \
    'MOCK_|DEFAULT_ENTERPRISE_|DEFAULT_AUDIT_LOGS|DEFAULT_CONVERSATIONS|INITIAL_STAFF_LIST|BACKEND_REVIEWS_DATA|notif_seed_|inv_mock_|sess_current|usr_current|默认高品质服务样本|保证至少有合理的统计底数|丰富 Mock 数据' \
    apps/web/src/pages apps/api/src/queries 2>/dev/null || true)
  [[ -n "$hits" ]] && report \
    "业务界面或 API 查询中存在静默演示数据" \
    "生产数据可信性：空数据只能显示空态，演示数据必须进入隔离 demo tenant" \
    "删除页面/API fallback，并让无数据显示 EmptyState、零值或明确错误。" \
    "$hits"
fi

# ── 8. 数据库测试必须经过隔离环境闸门 ───────────────────────────────────────
# 普通 sharedTestConfig 会加载通用测试环境，但不会映射任何数据库连接。API/DB
# 两个写库套件必须显式打开 database 模式，由 vitest.shared.ts 校验 TEST_* 变量。
for config in apps/api/vitest.config.ts packages/db/vitest.config.ts; do
  if ! grep -Fq 'createSharedTestConfig({ database: true })' "$config"; then
    report \
      "$config 绕过了数据库测试隔离闸门" \
      "数据库测试只能连接显式标记的独立 test 环境" \
      "配置必须使用 createSharedTestConfig({ database: true })。" \
      "$config"
  fi
done


# ── 9. 业务表的写入只能发生在命令处理器里 ───────────────────────────────────
# 宪法第 1 条是唯一一条以前没有可执行检查的规则，于是四条 desk 路由
# 悄悄长出了裸 SQL 写入（AUD-04）：改预约备注、改客户关联、重填健康表、
# 推进建站工单状态。它们各自丢掉了审计、幂等和欠费冻结，
# 而且因为「读也用 withTenant」，写混进去看起来毫无违和。
#
# 允许名单只有几处，每一处都有明确理由：
#   handlers/     命令处理器本身
#   bus.ts        幂等表
#   audit.ts      审计表（append-only）
#   platform/     运营侧写入，走 writePlatformAudit
#   signup/ stripe/ auth/ queries/pairing.ts kiosk/routes.ts
#                 系统路径：没有登录用户，写的是自己的会话/事件表
#   voice/references.ts 仅保存有 TTL 的工具引用缓存，不修改预约等业务实体
#   test/ tidy.ts qa/  测试与开发工具
WRITE_RE='(insert[[:space:]]+into|delete[[:space:]]+from|update[[:space:]]+[a-z_]+[[:space:]]+set)'
hits=$(grep -rnE $SRC -i "$WRITE_RE" apps/api/src 2>/dev/null \
  | grep -v '\.test\.ts:' \
  | grep -vE '^apps/api/src/(handlers|platform|signup|stripe|auth|email|notify|sms|telnyx|forms|onboarding|test|qa|ops|integrations|copilot)/' \
  | grep -vE '^apps/api/src/(bus|audit|money|tidy|businessSummary)\.ts:' \
  | grep -vE '^apps/api/src/(queries/pairing|queries/forms|kiosk/routes|billing/usage|public/routes|public/formRoutes|voice/references)\.ts:' \
  | grep -vE ':[0-9]+:[[:space:]]*(//|\*|--)' \
  || true)
[[ -n "$hits" ]] && report \
  "命令处理器之外出现了业务表写入" \
  "宪法第 1 条：所有写操作必须是命令（有名字、权限、幂等、审计）" \
  "把这段写入搬进 apps/api/src/handlers/ 的一条命令，路由只做 HTTP 形状适配。" \
  "$hits"

# ── 10. 调模型之前必须过准入闸门 ─────────────────────────────────────────────
# AUD-03：判据是**位置**不是数量（见 scripts/check-ai-gate.mjs 的头注释）。
if command -v node >/dev/null 2>&1; then
  hits=$(node scripts/check-ai-gate.mjs 2>&1 || true)
  [[ -n "$hits" ]] && report \
    "有模型调用没有被 AI 准入闸门覆盖" \
    "AUD-03：欠费 / 额度耗尽 / 限频必须挡在花掉第一个 token 之前" \
    "在该调用紧邻的上一行加 await assertAiAdmission(ctx)。" \
    "$hits"
fi

# ── 11. 权限对账：界面画的门 vs 服务端判的门 ─────────────────────────────────
# AUD-02：权限的粒度是「命令」，但有些能力藏在别的命令的入参字段里
#（打折、超容量），那类权限曾经在全仓一处判定都没有 —— 店主取消勾选
# 以为限住了，实际什么也没发生。脚本自带待决清单，新出现的缺口会当场报红。
if command -v node >/dev/null 2>&1 && [[ -x node_modules/.bin/tsx ]]; then
  hits=$(node_modules/.bin/tsx scripts/check-permission-matrix.mjs 2>&1 || true)
  if ! grep -q '✓ 权限对账通过' <<< "$hits"; then
    report \
      "权限对账发现不一致" \
      "亮着却注定 403 的按钮会被用户读成系统故障；永不生效的权限是给店主的假承诺" \
      "按下面的分类处理：漏门禁补 useCan*/GuardedButton；死权限补判定或删掉。" \
      "$hits"
  fi
fi

# ── 12. 钱路径上不得用宽容解析器当校验 ───────────────────────────────────────
# AUD-04：`dollarsToCents('abc')` 返回 0、`parseFloat(x) || 0` 归零、
# `parseInt(x) || 365` 回落默认值 —— 三者都是「打错字就悄悄换个值」，
# 而用户永远不会知道：界面提示保存成功，数字看起来也合理。
if command -v node >/dev/null 2>&1; then
  hits=$(node scripts/check-money-parsing.mjs 2>&1 || true)
  if ! grep -q '✓ 钱路径解析检查通过' <<< "$hits"; then
    report \
      "钱路径上出现了静默纠正" \
      "金额/比率/数量填错必须当场说「不」，不能替用户换一个看起来合理的值" \
      "改用 apps/web/src/lib/validation.ts 的 parse* 判定，失败交给 useValidationMessage 出文案。" \
      "$hits"
  fi
fi

# ── 13. 幂等键必须随「意图」走，不随「调用」走 ───────────────────────────────
# AUD-05：门店超时是常态，而超时不代表没写进去。键在调用处现生成的话，
# 前台重按一次就是第二条命令 —— 现金小费发两遍、加项加两条。
if command -v node >/dev/null 2>&1 && [[ -x node_modules/.bin/tsx ]]; then
  hits=$(node_modules/.bin/tsx scripts/check-idempotency.mjs 2>&1 || true)
  if ! grep -q '✓ 幂等键稳定性检查通过' <<< "$hits"; then
    report \
      "幂等键在提交时才生成" \
      "超时重按必须复用同一个键，否则 idempotency: 'required' 形同虚设" \
      "用 lib/idempotency.ts 的 useAttemptKey，或按业务身份拼稳定串（如 queue-pay-\${ticketId}-\${stage}）。" \
      "$hits"
  fi
fi

# ── 14. 文案 key 必须存在于字典 ─────────────────────────────────────────────
# AUD-07：`t()` 的签名是 `TranslationKey | string`，那个 `| string` 是逃生口 ——
# 拼错或取错命名空间没有任何编译期错误。开发环境渲染成 ⟦key⟧ 还看得见，
# 生产环境**原样把 key 显示给用户**，而没人会去看前台的浏览器控制台。
if command -v node >/dev/null 2>&1 && [[ -x node_modules/.bin/tsx ]]; then
  hits=$(node_modules/.bin/tsx scripts/check-i18n-keys.mjs 2>&1 || true)
  if ! grep -q '✓ 文案 key 检查通过' <<< "$hits"; then
    report \
      "代码里引用了字典中没有的文案 key" \
      "生产环境下这些 key 会原样出现在前台屏幕上" \
      "在 apps/web/src/i18n/ 下对应的域文件里补齐五种语言的词条。" \
      "$hits"
  fi
fi

echo
if [[ $FAIL -eq 0 ]]; then
  echo "${G}✓ 全部通过${N}"
else
  echo "${R}宪法检查未通过。上面每条都写了为什么要守。${N}"
  exit 1
fi
