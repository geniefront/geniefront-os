# Current state — GenieFront OS

Date: 2026-08-31

## Launch / QA posture

- **Batches 1–7.5:** complete and accepted.
- **Independent final audit (2026-08-31):** 13 findings (1×P0, 2×P1, 7×P2, 3×P3). **All thirteen are fixed and verified.** See `docs/qa/QA_FINDINGS.md` (AUD-01…AUD-13).
- **Real Stripe TEST commercial E2E:** PASS (`docs/qa/COMMERCIAL_E2E.md`).
- **Seed V2:** `packages/db/src/qa`, `docs/qa/TEST_DATA_AUDIT.md`, `docs/qa/SEED_SCENARIOS.md`.
- **apps/ios:** deferred.
- **Test counts:** `@gf/api` 775, `@gf/web` 169, `@gf/db` 73, `@gf/marketing` 14, Playwright 34/34 — all green.
- **Open counted findings:** P0=0, P1=0, P2=0, P3=0.

## ⭐ System-only commands (new architecture rule, AUD-01)

A command may now declare `system: true` in `packages/contracts/src/command.ts`.

**What it means:** the command records a fact that *already happened in an external
system* (Stripe charged a card, a subscription changed, a model call was billed).
It is not an intent a tenant can originate.

**The test:** if a tenant could call it directly, could they write down a fact that
never happened? `billing.syncSubscription` → they could hand themselves Growth/active.
`billing.recordTopup` → they could mint 100,000 AI credits. Both were reachable, and
both were demonstrated live during the audit.

**Two enforcement points, both fail closed:**

| Layer | File | Behaviour |
|---|---|---|
| HTTP entry | `apps/api/src/server.ts` | `POST /v1/commands/:name` rejects any `system: true` command before identity is even resolved |
| Bus | `apps/api/src/bus.ts` | `dispatch()` refuses a `system: true` command unless the caller passes `systemOrigin` — **before input validation**, so refusal never depends on the caller guessing the body shape |

`systemOrigin` names the external credential that was verified first
(`stripe_webhook`, `stripe_payment_intent`, `anthropic_usage`, `telnyx_call`,
`signup_claim`, `auto_topup_orchestrator`). Only server code can supply it.

⚠️ `ai: { exposed: false }` is **not** this. It only suppresses AI tool generation and
has never affected HTTP routing — that gap is what made the P0 reachable.

Tests: `apps/api/src/systemOnly.test.ts` iterates the whole command registry, so a new
internal command that forgets `system: true` turns the suite red.

## AI admission gate (AUD-03)

`apps/api/src/billing/aiAdmission.ts` — `assertAiAdmission(ctx, unit)` runs
**immediately before every model call**: past-due freeze, quota exhaustion,
per-location rate limit. New error codes `AI_QUOTA_EXHAUSTED` (402) and
`AI_RATE_LIMITED` (429).

Metering is unchanged: a call that *did* happen is still recorded truthfully and the
balance may still go negative. The gate governs the *next* call, not the current one.

`scripts/check-ai-gate.mjs` (wired into `pnpm lint:guards`) fails the build if any
model call lacks a gate above it. It caught a second `askCopilot` call site during
implementation.

## ⭐ Desk 的「今天」= 营业日（AUD-13）

**产品口径：Desk 上一切 Today / Yesterday 都是门店的营业日，含
`business_day_cutoff`，不是日历午夜。**

```
America/New_York，cutoff 04:00
  2026-08-31 01:30 EDT  →  营业今天 2026-08-30，营业昨天 2026-08-29
  2026-08-31 04:00 EDT  →  营业今天 2026-08-31
```

| 事实源 | 位置 |
|---|---|
| 判据（唯一一份） | `businessDateOf` @ `packages/scheduling` —— 前后端共用 |
| 前端入口 | `useBusinessDay()` @ `apps/web/src/lib/time.ts` |
| cutoff 下发 | `GET /v1/me/context` → `businessDayCutoff`（`HH:MM`） |

已接入：ScheduleContext（共享日期导航）、Dashboard、Schedule、Rotation、
Queue/操作板、Day Close、Layout 的日程入口、BusinessData 的报表区间。

⚠️ **不要再写第二份日期实现**，也不要用 `toISOString().slice(0,10)`
或浏览器本地日历语义。`lint:guards` 尚未覆盖这一条 —— 判据在这里，
新页面照抄 `useBusinessDay()`。

⚠️ 会话未就绪时 `useBusinessDay().ready` 为 false、`today` 为空串。
调用方必须据此**不发请求**，不要先用猜的日期打一发。

## Production migrations still required

Apply in order. Do not rewrite numbered files.

| File | Topic |
|---|---|
| `sql/0072_stripe_invoice_tenant.sql` | Stripe invoice tenant isolation |
| `sql/0073_10dlc_internal_review.sql` | 10DLC internal review |
| `sql/0074_platform_console.sql` | `platform_operators` + support requests |
| `sql/0075_stripe_ids_system_owned.sql` | Stripe id ownership (superseded by 0080 — still apply in order) |
| `sql/0076_customer_same_org_fk.sql` | AUD-05 cross-org customer FK |
| `sql/0077_support_notes_operator_only.sql` | AUD-08 operator-only support notes |
| `sql/0078_idempotency_retention.sql` | AUD-09 idempotency purge function |
| `sql/0079_sms_inbound_isolation.sql` | AUD-10 inbound SMS RLS |
| `sql/0080_stripe_ids_one_org.sql` | AUD-02 one Stripe id ↔ one org + multi-store tenant resolution |
| `sql/0081_stripe_single_org_definer.sql` | AUD-02 the 0080 trigger must be SECURITY DEFINER |

⚠️ **When running migrations against the isolated QA database, pass
`APP_DB_PASSWORD="$TEST_APP_DB_PASSWORD"`.** `migrate.ts` resets the `app_user` login
password from that variable; using the dev/prod value locks the test suite out of the
local database with an opaque `password authentication failed`.

## Canonical product facts (do not reopen)

- Plans: `essential` / `growth` only. `PLAN_PRICES_CENTS` $99 / $199.
- **Stripe is paid-state truth, and it is now enforced rather than assumed.**
  `billing.changePlan` / `billing.buyAddon` refuse local paid mutation; every other
  billing writer is `system: true` and unreachable from a browser.
- Stripe customer/subscription ids are system-owned. One id belongs to exactly one org
  (DB trigger). Multiple *locations within one org* deliberately share them — one owner,
  one card, one invoice.
- 10DLC `pending_review` = received by GenieFront, not carrier/TCR filed.
- Platform auth = `platform_operators` active row. Owner role never suffices.
- Support requests are tenant-scoped. **Operator notes are not** — `support_request_notes`
  requires an active operator at the RLS layer.

## Seed V2 commands

```bash
pnpm qa:reset
pnpm qa:seed <scenario>
```

Requires `GF_QA_ALLOW_RESET=1` and the isolated `TEST_*` database URLs.
