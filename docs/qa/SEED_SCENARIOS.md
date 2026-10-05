# Seed V2 scenarios

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


QA reset/seed is scenario-selectable. It does **not** rebuild Lotus/Golden Foot.

```bash
GF_QA_ALLOW_RESET=1 DATABASE_TEST_TARGET=isolated \
  TEST_DATABASE_URL=... TEST_MIGRATION_DATABASE_URL=... \
  pnpm qa:reset

GF_QA_ALLOW_RESET=1 DATABASE_TEST_TARGET=isolated \
  TEST_DATABASE_URL=... TEST_MIGRATION_DATABASE_URL=... \
  pnpm qa:seed essential_trial
```

Password for every QA auth user: `GenieQa!2026`  
Emails: `qa-<scenario>@maildrop.cc` (plus `.owner` / `.tech` / `.front_desk` suffixes where noted).

Clock: `QA_NOW` (ISO-8601) freezes “now”. Unset → `Date.now()`.  
Business dates use the location IANA timezone, never the machine zone. Default shop zone: `America/New_York`. Multi-location west shop: `America/Los_Angeles`.

Stripe fixture IDs are `cus_qa_*` / `sub_qa_*` / `pi_qa_*`. They are **not** live Checkout objects. They write the same columns as `billing.syncSubscription` / `billing.recordTopup`.

---

## Architecture

| Layer | Mechanism | Used for |
|---|---|---|
| Low-level insert | `packages/db/src/qa/bootstrap.ts` | auth identity, `users`, org, location, roles, membership, staff_profiles |
| Stripe-state fixture | `applyStripeSyncFixture` / `applyRecordedTopupFixture` | plan, subscription_status, trial_ends_at, purchased ledger |
| Command-equivalent SQL | `lifecycle.ts`, `features.ts`, `shopData.ts` | `catalog.saveService`, `staff.add`/`staff.saveProfile`, `appointment.create`, `queue.join`, `ticket.open`, `ticket.close`, `giftcard.issue`, `dayclose.saveCount`, `settings.apply10dlc`, `storefront.submit`, `support.submitRequest` |
| Not used | `billing.changePlan`, `billing.buyAddon` | — |

Identity inserts preserve RLS relationships (`org_id` / `location_id` / `user_id` / membership roles). Business rows match command outputs so later browser QA can run the real commands on top.

---

## Scenario catalog

Login email is `qa-<id>@maildrop.cc` unless stated.

### 1. `fresh_owner`

- User: QA Owner (`qa-fresh_owner@maildrop.cc`), owner
- Org / location: one shop, `America/New_York`, `locations.status=setup`
- Plan / sub: essential / trialing, trial end in the future (TRIAL_DAYS)
- Setup: claimed signup intent, **no catalog**
- Permitted: setup wizard, `setup.*`, billing portal path
- Forbidden: treating the shop as open (`location.finishSetup` not done)

### 2. `setup_incomplete`

- Same billing as trial Essential
- Location `status=setup`, claimed
- Empty catalog — wizard still required
- Permitted: remaining setup commands
- Forbidden: assuming desk is the daily driver

### 2a. `growth_setup`

- Same incomplete setup shape as `setup_incomplete`, with Growth / trialing billing
- Claimed Growth signup intent and an empty catalog
- Login: `qa-growth_setup@maildrop.cc`
- Permitted: the complete Growth SetupWizard browser journey

### 3. `empty_shop`

- Owner, location `status=active`
- Catalog exists, **zero customers / appointments / tickets**
- Plan: essential / trialing
- Permitted: create customers, book, open tickets
- Forbidden: expecting queue/board population

### 4. `essential_trial`

- Owner on an active shop with a small catalog
- `plan=essential`, `subscription_status=trialing`, `trial_ends_at` in the future
- Quota = `TRIAL_QUOTA` (150 credits / 20 minutes), **not** Essential’s 500/60
- Permitted: trial-included AI usage until quota
- Forbidden: Growth features that require `plan=growth`; treating trial as paid-active

### 5. `growth_active`

- Owner, active shop
- `plan=growth`, `subscription_status=active`, trial cleared
- Quota = `PLAN_QUOTAS.growth` (1200 / 500)
- Permitted: normal writes, billing portal
- Forbidden: trial copy / Essential quota

### 6. `past_due`

- Owner, active location row (login still works)
- `plan=growth`, `subscription_status=past_due`
- Writes other than `billing.*` / `setup.*` / `support.*` throw `SUBSCRIPTION_PAST_DUE`
- Permitted: billing recovery (`billing.syncSubscription` from a real webhook or this fixture)
- Forbidden: ticket/appointment/catalog writes while frozen

### 7. `multi_location_owner`

- Same user owns **East Side Nails** (`America/New_York`) and **West Side Spa** (`America/Los_Angeles`)
- Distinct customers (Lisa/Emily vs David/Ming), distinct services, distinct appointments
- Both locations Growth / active
- Permitted: switch location; operate each store
- Forbidden: seeing East customers on West (cache/tenant leakage target)

### 8. `owner`

- Login is the owner (`qa-owner@maildrop.cc`)
- Active Growth shop with a tech on staff
- Permitted: `billing.manage`, `settings.manage`, `dayclose.manage`
- Forbidden: confusing this user with platform ops

### 9. `manager_or_front_desk`

- Login: `qa-manager_or_front_desk@maildrop.cc` with **front_desk only**
- Hidden owner: `qa-manager_or_front_desk.owner@maildrop.cc`
- Permitted: tickets, queue, day-close (desk-only), appointments
- Forbidden: `billing.manage`, platform console

### 10. `tech_only`

- Login: `qa-tech_only@maildrop.cc` with **tech only**
- Hidden owner: `qa-tech_only.owner@maildrop.cc`
- Permitted: `ticket.write`, `appointment.read`, own payroll
- Forbidden: `settings.manage`, `billing.manage`, `dayclose.manage`, `staff.manage`

### 11. `busy_shop`

- Owner + front_desk + two techs
- Today: booked appointment, in-service ticket, walk-in queue (`queue.join` shape: appointment + `walkin_queue`)
- Rooms/chairs exist
- Growth / active
- Permitted: board, finish service, checkout
- Forbidden: impossible ticket/payment pairs (open ticket is unpaid; closed ones in other scenarios have payments)

### 12. `gift_card_shop`

- Issued card: face $100 / sale $80 / ledger +10000
- `balance_cents` cache equals ledger sum
- Permitted: redeem via `giftcard.redeem` / `ticket.close` gift_card method
- Forbidden: treating `balance_cents` as source of truth without ledger

### 13. `day_close_ready`

- One completed, **paid** ticket today (card + tip)
- `day_closes.status=counted` with `counted_cash_cents=0` and `card_terminal_cents` = payment total
- No open tickets
- Permitted: `dayclose.finalize` (variance 0)
- Forbidden: pre-inserting a `closed` day-close with invented gross

### 14. `ten_dlc_pending`

- Tenant login: `qa-ten_dlc_pending@maildrop.cc`; active internal reviewer: `qa-ten_dlc_pending.operator@maildrop.cc`
- `location_10dlc_registrations.status=pending_review`
- Notes state internal GenieFront review; **not** TCR/carrier submitted
- Permitted: platform internal review actions
- Forbidden: copy or fixtures that say “carrier review”

### 15. `storefront_pending`

- `storefront_briefs.status=submitted`
- Permitted: platform storefront queue
- Forbidden: treating it as live

### 16. `support_request_open`

- Tenant login: `qa-support_request_open@maildrop.cc`; active internal operator: `qa-support_request_open.operator@maildrop.cc`
- Three requests: `open`, `in_progress`, `resolved` (`resolved_at` set on resolved)
- `open` is the `support.submitRequest` shape
- Permitted: customer sees open; platform updates status
- Forbidden: bypassing status check constraint

### 17. `platform_operator`

- User `qa-platform_operator@maildrop.cc`
- `platform_operators.role=super_admin`, `status=active`
- **No** shop membership
- Permitted: `/v1/platform` session
- Forbidden: logging into desk as this identity expecting a store

### 18. `revoked_platform_operator`

- User `qa-revoked_platform_operator@maildrop.cc`
- `status=revoked`, `revoked_at` = clock − 30 days
- Permitted: none on platform
- Forbidden: treating former ops email as authorized

---

## Relative time / timezone

- `packages/db/src/qa/clock.ts` — `QA_NOW`, IANA zones, cutoff-aware business dates, DST-safe wall-minute conversion (same iteration as `packages/scheduling` `wallMinuteToInstant`).
- Tests freeze `QA_NOW=2026-08-30T16:00:00.000Z` so two reset+seed runs compare equal.
- Do not use `new Date().getDate()` in the machine zone.

## Reset / idempotency

`qa:seed <scenario>` always wipes **all** Seed V2 tenants first, then seeds that one scenario. A second `qa:reset` + `qa:seed` produces the same logical snapshot (counts, plan, statuses, emails, roles). Deterministic UUIDs (`qaUuid`) prevent duplicates.

Lotus/Golden Foot (`11111111-…` / `22222222-…`) are **not** deleted.

## Production safety

`packages/db/src/qa/safety.ts` refuses unless **all** of:

1. `NODE_ENV` is `test` / `development` / `qa` (never `production`)
2. `GF_QA_ALLOW_RESET=1`
3. `DATABASE_TEST_TARGET=isolated`
4. `MIGRATION_DATABASE_URL` is explicit in the process env (not implicit `.env` fallback)
5. Host is local (`127.0.0.1` / `localhost` / `::1`); port 55322 is refused because it is the persistent manual-QA database
6. Roles are `postgres` (migration) and `app_user` (app)
7. URLs do not contain `qiuyubvhirjtglonbkon`, `geniefront.com`, `desk.geniefront.com`, `api.geniefront.com`

Reasons never include passwords.
