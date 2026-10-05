# Test data audit — Seed V2

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


Date: 2026-08-30  
Scope: seed scripts, fixtures, factories, database test helpers, auth/org/location/membership/billing/appointment/queue/ticket/gift-card/payroll/10DLC/storefront/platform/support/Stripe/date helpers.  
Production application code was not changed except existing test seams (gift-card suite now uses `billing.syncSubscription`; `setup:test:reset` uses the Seed V2 Stripe fixture).

## Systems found

| Mechanism | Path | What it creates | Classification |
|---|---|---|---|
| Regression seed | `packages/db/src/seed.ts` (`pnpm db:seed`) | Lotus Nails + Golden Foot Spa: identity, catalog, 29-day shifts, historical tickets/payments, gift cards without ledger, reviews (`Math.random` ids), no `billing_accounts` | **KEEP** (regression). Do not use for new browser QA. |
| Isolated seed reset GUC | `packages/db/sql/0061_isolated_seed_reset.sql` | Allows postgres-role + `app.seed_reset=on` to rebuild append-only history | **KEEP** |
| API suite reset | `apps/api/src/test/resetDatabase.ts` | Execs `pnpm db:seed` with `SEED_SKIP_AUTH=1` after isolated-DB guard | **KEEP** |
| Vitest DB gate | `vitest.shared.ts` `createSharedTestConfig({ database: true })` | Maps `TEST_*` only; refuses missing isolated target / same-as-dev URL / wrong roles | **KEEP** |
| Setup-test reset | `packages/db/src/resetSetupTest.ts` (`pnpm setup:test:reset`) | Fresh claimed Growth shop via `gf_provision_tenant` | **UPDATE** — paid state now goes through Seed V2 `applyStripeSyncFixture` (same columns as `billing.syncSubscription`) |
| Dev tidy | `apps/api/src/tidy.ts` (`pnpm db:tidy`) | Voids parked tickets through `ticket.void`; restores a few demo appointments without reseeding phones | **KEEP** |
| SQL provision | `gf_provision_tenant` in `sql/0030_signup.sql` | Org + location `status=setup` + empty `billing_accounts` | **KEEP** (production writer) |
| Command bus tests | `apps/api/src/*.test.ts` | Per-file `withTenant` inserts / `dispatch(...)` on Lotus/Golden Foot IDs | **KEEP** unless a case fabricates paid state casually |
| Billing reset helper | `apps/api/src/billing.test.ts` `resetBilling()` | Ledger-true zeroing + `subscription_status='trialing'` for billing unit tests | **KEEP** (tests the billing writer itself) |
| Gift-card suite paid unfreeze | `apps/api/src/giftcard.test.ts` | Was `update billing_accounts set subscription_status='active'` | **UPDATE** → `billing.syncSubscription` |
| Stripe webhook tenant tests | `apps/api/src/stripe/webhook.tenant.test.ts` | Inserts billing rows then signed webhook path | **KEEP** (intentional Stripe-sync tests) |
| Platform RLS fixtures | `packages/db/src/rls.test.ts` + seed operators `ops@` / `exops@` | Active/revoked `platform_operators` | **KEEP** |
| Hardcoded UI/i18n dates | `apps/web/src/i18n/*`, mock pages | Display copy, not DB seed | **KEEP** (out of Seed V2). Do not treat as “today”. |
| Frontend mock data | `apps/web/src/features/forms/mockData.ts` etc. | Component tests only | **KEEP** |
| Negative plan tests | `apps/api/src/signup/checkout.test.ts`, `apps/web/src/features/billing/display.test.ts`, `packages/payroll/src/credits.test.ts` | `starter` / `enterprise` / `$89` asserted **absent** | **KEEP** (negative) |
| Seed V2 | `packages/db/src/qa/*` (`pnpm qa:reset` / `pnpm qa:seed <scenario>`) | Scenario tenants, relative time, Stripe-sync fixture, production refusal | **KEEP** (new) |

No separate factory package exists. Tests either share the Lotus/Golden Foot IDs or insert rows inline.

## KEEP / UPDATE / REPLACE / REMOVE

### KEEP

- **Lotus/Golden Foot regression seed.** Batches 1–7.5 API tests hard-code `NAIL_ORG` / `SPA_ORG`. Replacing it would rewrite history. Known limitations stay documented below; they are **not** used as valid-state fixtures for browser QA.
- **Negative `starter` / `enterprise` tests.** Signup checkout and display tests reject those names. That is current invariant, not stale data.
- **`billing.test.ts` reset helper.** It is exercising the billing account, not pretending Stripe paid.
- **Fixed dates in arithmetic tests** (`gapdays.test.ts` 2026-03-07 DST, `rotation/engine.test.ts` 2026-08-15, `credits.test.ts` `NOW`). Those tests are about date math, not “today”.
- **`vitest.shared.ts` isolated DB gate** and **`0061` seed_reset GUC**.

### UPDATE

| Item | Stale / impossible | Invariant violated | Dependents | Seed V2 replacement |
|---|---|---|---|---|
| `resetSetupTest.ts` wrote `subscription_status='active'` + fake `cus_test_*` / `sub_test_*` directly | Fabricated paid Growth | Stripe is paid-state truth; writer is `billing.syncSubscription` | `pnpm setup:test:reset` | `applyStripeSyncFixture` (same columns as `billing.syncSubscription`) |
| `giftcard.test.ts` `update billing_accounts set subscription_status='active'` | Casual paid-state flip | Same | Gift-card integration suite | `dispatch('billing.syncSubscription', { plan:'growth', subscriptionStatus:'active' })` |
| Regression seed gift cards (`GC-VIP-8888` etc.) | `balance_cents` set with **no** `customer_credit_ledger` | Ledger is truth; cache must match | Visual demo only; gift-card tests issue via command | Seed V2 `giftcard.issue`-equivalent: insert card at 0, append `issue` ledger, then cache |
| Regression seed `day_closes` | Hardcoded `gross_cents=22000` etc., not derived from that day’s tickets | Day-close totals come from payments | Unlikely asserted by count | Seed V2 `day_close_ready`: closed tickets + matching payments + `dayclose.saveCount`-shaped row, **not** pre-finalized |
| Regression seed reviews | `Math.random()` external ids | Determinism | None | Seed V2 does not seed reviews unless a later scenario needs them |
| Regression seed billing | Deletes `billing_accounts` and does not recreate | Bus treats missing row as “not billed yet” (intentional for Lotus). Invalid as a paid/trial shop | Billing tests auto-`ensureAccount` | Every Seed V2 shop that represents a commercial state gets `applyStripeSyncFixture` |
| `exops` `revoked_at='2026-01-01'` | Fixed historical timestamp | Fine as “revoked in the past”; not “today” | `rls.test.ts`, platform tests | Seed V2 revoked operator uses `now - 30 days` |

### REPLACE

| Item | Why | Dependents | Replacement |
|---|---|---|---|
| “One giant universal store” as the QA database | Cannot represent `fresh_owner`, `past_due`, `tech_only`, `platform_operator` without contamination | Future browser QA | Seed V2 scenarios (see `SEED_SCENARIOS.md`) |
| Any valid-state fixture using plan `starter` / `enterprise` | Canonical plans are `essential` \| `growth` | None remaining as valid-state DB rows | Negative tests only |
| Fake paid invoices / Stripe receipt URLs in seed | Stripe remains invoice truth | Settings UI tests already forbid `$89/$169/$299` and `INV-2026-*` | Seed V2 never inserts `billing_invoices` |

### REMOVE

Nothing removed from Batches 1–7.5 regression suites.

No test file was deleted.

## Stale / dangerous assumptions (Phase 2)

### Plans

Canonical: `essential`, `growth` (`packages/payroll/src/credits.ts`).

`starter` / `enterprise` remain **only** as negative cases:

- `apps/api/src/signup/checkout.test.ts` — HTTP 400 `invalid_signup`
- `apps/web/src/features/billing/display.test.ts` — `canonicalPlan` returns null
- `packages/payroll/src/credits.test.ts` — keys absent from `PLAN_PRICES_CENTS`

Valid-state Seed V2 fixtures never write those values.

Historical SQL `0018` / drizzle snapshots still mention `starter`/`pro`. Those are applied migrations, not live writers.

### Pricing

Display cents: `PLAN_PRICES_CENTS` = Essential **9900**, Growth **19900**.

Seed V2 does not embed `$89` / `$169` / `$299`. Marketing and BillingPanel tests already assert those strings are absent.

### Billing / Stripe

Stripe remains paid-state truth.

Seed V2 financial fixture:

1. `applyStripeSyncFixture` — same `billing_accounts` columns as `billing.syncSubscription` (`plan`, `subscription_status`, `trial_ends_at`, `current_period_end`, `cus_qa_*` / `sub_qa_*`).
2. `applyRecordedTopupFixture` — same `credit_ledger` shape as `billing.recordTopup` (`kind=topup`, `amount>0`, `paid_cents=5000`, `pi_qa_*`). Used only when a purchased balance is required.
3. Never `billing.changePlan` / `billing.buyAddon`.
4. Never insert `billing_invoices` or receipt URLs.

### 10DLC

Customer submit → `pending_review` = received by GenieFront for **internal** review. Not TCR, not carrier.

Regression seed has no 10DLC rows.

Seed V2 `ten_dlc_pending` writes `pending_review` with notes: “Internal GenieFront review. Not filed with TCR or a carrier.”

### Platform

Authorization is `platform_operators` with `active` / `revoked`. Owner role and email hardcodes do not grant platform access.

Seed V2 `platform_operator` / `revoked_platform_operator` insert only that table (zero memberships).

### Support

Real model (`sql/0074`): `open` \| `in_progress` \| `waiting` \| `resolved` \| `closed`.

Customer command `support.submitRequest` always inserts `open`. `in_progress` / `resolved` in Seed V2 represent the platform transition (`resolved_at` set when resolved).

### Dates

| Kind | Examples | Action |
|---|---|---|
| Relative “today” | Regression seed 14-day window via `Intl` + location TZ | Seed V2 uses `QA_NOW` + IANA zone (`America/New_York`, `America/Los_Angeles`) |
| Historical / arithmetic | DST 2026-03-08, rotation 2026-08-15 | **KEEP** |
| Copy / mock | i18n `2026-09-01`, Tickets fallback `2026-08-26` | Not seed data; out of this batch |
| Rotting “today” in fixtures | `revoked_at='2026-01-01'` in regression seed | Keep as historical; Seed V2 uses relative `-30d` |

## How tests currently create DB state

1. **Shared regression seed** at API suite start (`resetDatabase.ts` → `db:seed`).
2. **Inline SQL** inside `withTenant` for extra customers/tickets (e.g. `audit_fixes.test.ts`).
3. **`dispatch(command, input, ctx)`** for command-path assertions.
4. **Setup-test reset** for a claimed, unfinished onboarding tenant.

Seed V2 does (1)-style wipe only of `settings.qa_seed='v2'` tenants, then (low-level identity) + Stripe fixture + command-equivalent business rows.
