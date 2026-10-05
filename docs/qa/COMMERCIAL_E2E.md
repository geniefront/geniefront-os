# Commercial E2E — Stripe TEST MODE

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


Date: 2026-08-30  
Scope: real marketing → `POST /v1/public/signup-checkout` → Stripe Hosted Checkout → signed webhook → tenant provisioning → activation → claim → setup → desk → Billing.  
No production credentials, production customer data, or production email/SMS were used.

## COMMERCIAL TEST E2E: PASS

The paid commercial path worked in Stripe TEST MODE. One product defect was repaired in this phase: `/signup/success` no longer claims checkout without server-side session verification.

## 1. Environment

All active keys and hosts used for this run were TEST / local / non-production.

| Component | Kind | Notes |
| --- | --- | --- |
| Stripe secret / publishable keys | real Stripe TEST | prefixes `sk_test_` / `pk_test_`; Balance `livemode=false`; Stripe account is the JAYSEN LABS LLC sandbox |
| Stripe Price IDs | real Stripe TEST | Essential `price_1U5FREJDnwqCtyJGe1pVlXUZ` $99/mo `livemode=false`; Growth `price_1U5FRZJDnwqCtyJGeJpplvcw` $199/mo `livemode=false` |
| Stripe webhook secret | real test-mode (Stripe CLI) | `stripe listen --forward-to 127.0.0.1:3000/v1/stripe/webhook`; CLI signing secret matched the local `STRIPE_WEBHOOK_SECRET` |
| Database | local isolated Postgres | `127.0.0.1:54322` (`DATABASE_TEST_TARGET=isolated`). Remote DEV Supabase was **not** written. Production project `qiuyubvhirjtglonbkon` stayed commented out |
| Supabase Auth | local | `http://127.0.0.1:54321`; GoTrue `SITE_URL` / redirect allow-list updated locally so `/activate` on desk `localhost:5177` is accepted |
| Email | local capture | Mailpit/Inbucket `http://127.0.0.1:54324`. Addresses were `*@maildrop.cc` only |
| API | local | `http://127.0.0.1:3000`, `NODE_ENV=development` |
| Marketing | local | `http://localhost:5180` |
| Desk (`apps/web`) | local | `http://localhost:5177` |
| Rate limit backend | real Upstash REST when reachable, else per-process memory | `UPSTASH_REDIS_REST_URL` is set; `NODE_ENV=test` always uses memory |
| Checkout creation | **not mocked** | live `checkout.sessions.create` against Stripe TEST |
| Webhook signature | **not bypassed** | Stripe CLI signed deliveries; API returned HTTP 200 |

Local `.env` corrections used for this run (gitignored, not committed):

- `APP_BASE_URL=http://localhost:5177` (was `5173`; desk Vite is `5177`, matching `.env.example`)
- `MARKETING_BASE_URL=http://localhost:5180` (was unset, which would have sent Checkout success/cancel to `https://www.geniefront.com`)

Commented `sk_live_` / production Supabase values in `.env` were never activated.

## 2. Migrations (before testing)

Queried `_migrations` on both local isolated Postgres and remote DEV. **Not altered.**

| Migration | Local isolated | Remote DEV |
| --- | --- | --- |
| `sql/0072_stripe_invoice_tenant.sql` | APPLIED | APPLIED |
| `sql/0073_10dlc_internal_review.sql` | APPLIED | APPLIED |
| `sql/0074_platform_console.sql` | APPLIED | APPLIED |
| `_migrations` count | 85 | 85 |

This commercial run used the **local isolated** database.

## 3. Apps used

- `apps/api` on `:3000` (local TEST DB + Stripe TEST + CLI webhook secret)
- `apps/marketing` on `:5180`
- `apps/web` on `:5177` (local Supabase anon key)

## 4. Essential Checkout (real Stripe TEST)

| Field | Value |
| --- | --- |
| Shop | `E2E Essential 1788123807` |
| Owner email | `gf-e2e-ess-1788123807@maildrop.cc` |
| Plan requested | `essential` |
| Checkout Session | `cs_test_a1JLtssKfbNYYwLRNTdvpHabHoTZy7o5LaMfRDKOoMMtowB0H1y0LCIPO8` |
| livemode | `false` |
| Price | `price_1U5FREJDnwqCtyJGe1pVlXUZ` ($99, TEST) |
| `gf_signup` | `1` |
| `gf_shop_name` | `E2E Essential 1788123807` |
| `gf_owner_email` | `gf-e2e-ess-1788123807@maildrop.cc` |
| `gf_plan` | `essential` |
| `customer_email` | same as `gf_owner_email` |
| Payment method | Stripe test card `4242 4242 4242 4242` |
| Result | `status=complete`, `payment_status=paid`, subscription `sub_1UAFwpJDnwqCtyJGjc4HPr9r`, customer `cus_VAb9CFFhpSOgqz` |
| Success redirect | `http://localhost:5180/signup/success?session_id=cs_test_a1JLtssKfbNYYwLRNTdvpHabHoTZy7o5LaMfRDKOoMMtowB0H1y0LCIPO8` |

No live charge.

## 5. Signed webhook

Stripe CLI forwarded:

| Event | ID | API |
| --- | --- | --- |
| `checkout.session.completed` | `evt_1UAFwrJDnwqCtyJGqutyh9Di` | HTTP 200 |
| `customer.subscription.updated` | `evt_1UAFwsJDnwqCtyJGN5Kz4R11` | HTTP 200 |

`invoice.paid` / `customer.subscription.created` arrived **before** tenant metadata existed and were ignored with `stripe event without gf metadata` (HTTP 200, no fake tenant). After `checkout.session.completed`, provisioning and subscription sync ran.

Signature verification was not bypassed.

## 6. Tenant provisioning (Essential)

| Object | ID / state |
| --- | --- |
| organization | `8b676b66-287c-4a40-ae7d-522caa72eb6f` |
| location | `32575293-300c-4583-b2f0-d05ec835a39c` status `setup` then `active` |
| billing_accounts.plan | `essential` |
| subscription_status | `trialing` |
| trial_ends_at | `2026-09-06T21:07:26.000Z` |
| stripe_customer_id | `cus_VAb9CFFhpSOgqz` |
| stripe_subscription_id | `sub_1UAFwpJDnwqCtyJGjc4HPr9r` |
| signup_intent | `6c245700-8d08-469b-8a1b-01b7dcb5aa28` |

Stripe customer/subscription metadata backfill:

- customer `gf_location_id` / `gf_org_id` set
- subscription `gf_location_id` / `gf_org_id` / `gf_signup=1` set

## 7. Webhook replay / idempotency

`stripe events resend evt_1UAFwrJDnwqCtyJGqutyh9Di` → API 200, log `signup replayed` `already: true`.

After replay: still **1** `signup_intents` row and **1** location for that shop name. `stripe_events` row remains `processed`.

## 8. Activation

Local Mailpit captured one magic-link mail:

- To: `gf-e2e-ess-1788123807@maildrop.cc`
- Subject: `Your sign-in link`
- Link: `http://127.0.0.1:54321/auth/v1/verify?token=…&type=magiclink&redirect_to=http://localhost:5177/activate`

`signup_intents.activation_email_sent_at` was set. The redirect target is desk `/activate` and was accepted by local GoTrue allow-list.

## 9. Claim

Opening the magic link landed on `http://localhost:5177/activate`, password was set, then navigation to `/setup`.

| Check | Result |
| --- | --- |
| Owner membership | `bd8654f0-319d-448f-8386-f4da27fcfd41` role `owner` on location `32575293-300c-4583-b2f0-d05ec835a39c` |
| Claim SQL | `gf_signup_intent_for_user` / `setup.claimLocation` — not bypassed |
| Owner re-claim | `404 no_claimable_signup` |
| Unrelated user `gf-e2e-unrelated-1788123807@maildrop.cc` | `404 no_claimable_signup` |

## 10. Setup

Via authenticated commands (same APIs the Setup UI uses):

- `location.saveProfile`
- `location.saveHours`
- `catalog.saveService` → Classic Manicure
- `staff.saveProfile` bookable `Ava Tech`
- `location.finishSetup` → `{ status: 'active' }`

`GET /v1/me/locations` then reports `locationStatus=active` for this membership only.

## 11. First desk load

- After activation the browser was on `/setup` (SessionGate resolved; correct location).
- Password login landed on `/dashboard`, then `/settings?tab=billing`.
- Desk chrome showed `E2E Essential 1788123807`, owner `gf-e2e-ess-1788123807@maildrop.cc`, status 正常营运中.
- After finishSetup, `GET /v1/desk/day` → 200 with this tenant’s staff/services only:
  - staff: `Ava Tech`, owner
  - services: `Classic Manicure`
  - no Lotus / Selftest / `owner@maildrop.cc` seed leakage
- Customer Portal: `POST /v1/billing/portal-session` → `https://billing.stripe.com/p/session?secret=test…`
- One browser console 404 (resource load) was seen; no 5xx from desk APIs.

## 12. Billing truth (Essential)

Settings → Billing in the desk UI (and `GET /v1/desk/billing`) showed:

| Field | Value |
| --- | --- |
| plan | `essential` (not Starter / Enterprise / fake Growth) |
| subscriptionStatus | `trialing` |
| trialing | `true` |
| trialEndsAt | `2026-09-06T21:07:26.000Z` |
| currentPeriodEnd | `2026-09-06T21:07:26.000Z` |
| hasSubscription | `true` |
| quotas (trial) | credits 150, voice minutes 20 — canonical trial quota from `@gf/payroll`, not paid-period 500/60 |

UI copy: **基础版 (Essential) · 试用中**, trial end `2026-09-06`, quotas `0 / 20` voice and `0 / 150` AI, **暂无发票**, **尚未绑定银行卡**. No Starter / Enterprise / $169 / fake Growth.

No local `billing.changePlan`. Portal URL is real Stripe TEST.

Observation (not a path-breaker): Checkout stored `subscription.default_payment_method`, but `billing_accounts.default_payment_method_id` stayed null, so `hasPaymentMethod=false`. Card still exists on the TEST subscription; Portal can manage it.

## 13. Growth (separate identity)

Created from `apps/marketing` UI (`cta-growth`).

| Field | Value |
| --- | --- |
| Shop | `E2E Growth 1788124326` |
| Owner email | `gf-e2e-growth-1788124326@maildrop.cc` |
| Checkout Session | `cs_test_a1VSm1UHGkbjyIuiNCR3CCW245BA9YziZZgf2FdlZ4VyMEzea8kLULZ2UE` |
| livemode | `false` |
| Price | `price_1U5FRZJDnwqCtyJGeJpplvcw` ($199, TEST) |
| `gf_plan` | `growth` |
| `gf_signup` | `1` |
| `customer_email` | matches `gf_owner_email` |
| webhook | `evt_1UAG3nJDnwqCtyJGNbeKA2va` `checkout.session.completed` HTTP 200 |
| org | `01622410-e28a-436a-81c4-5f80311d06a8` |
| location | `2e3b4fd3-aec1-4560-b41c-3b7b023a0057` |
| billing.plan | `growth` |
| subscription | `sub_1UAG3mJDnwqCtyJGerbZfJab` trialing |
| customer | `cus_VAbG2mFKL1OZlw` |
| success lookup | `{ status: "confirmed", plan: "growth" }` |

Essential location `32575293-…` remained `plan=essential`. Growth org has one location. No cross-contamination.

Paid-period Growth quotas (1200 credits / 500 minutes) apply after trial; during trial both plans show the canonical 150/20 trial quota.

## 14. Negative signup cases

| Case | Result |
| --- | --- |
| invalid plan `starter` | HTTP 400 `invalid_signup`, no Checkout |
| malformed email | HTTP 400 |
| extra metadata / `priceId` | HTTP 400 (strict body) |
| arbitrary success/cancel URL | HTTP 400 |
| unknown session lookup | `{ status: "invalid" }` |
| missing `session_id` on success API | `{ status: "invalid" }` |
| expired Checkout `cs_test_a1tvQENfGF6qKaIhu5SD2IcpWes27OlQAZEHNM0o0F52RjBlUm4oNj5Nx7` | Stripe `expired` / unpaid; lookup `invalid`; **0** signup_intents / locations |
| `stripe trigger checkout.session.completed` (no `gf_signup`) | `evt_1UAG1TJDnwqCtyJGHiIziXKP` HTTP 200 `stripe event without gf metadata`; no tenant |
| webhook replay | no duplicate tenant |
| email mismatch | not forged as a live Checkout (server always sets both emails). Covered by `apps/api/src/signup.test.ts` (`provisionFromSession` refuses and writes nothing) |

## 15. Success-page verification

Defect: `/signup/success` was reachable by hand and said “Checkout received” without `session_id`.

Fix (smallest):

- `GET /v1/public/signup-session?session_id=`
- retrieves one Checkout Session from Stripe
- requires `gf_signup=1`, subscription mode, no `gf_location_id` on the session
- returns only `{ status: confirmed\|pending\|invalid, plan? }`
- rate-limited per IP; Stripe 404 → invalid; Stripe outage → 503 (UI treats as pending, never “paid”)

UI:

- no `session_id` / invalid → “Signup not confirmed” / does not say payment was received
- pending → “We're confirming your signup”
- confirmed → checkout completed + check email; shop not active yet

## 16. Abuse protection

| Control | Behavior |
| --- | --- |
| IP rate limit | `signup-ip` 10 / hour via `checkRateLimits` |
| Email-hash rate limit | `signup-email` SHA-256 of canonical email, 5 / hour |
| Backend | Upstash REST (`UPSTASH_REDIS_REST_URL`) when `NODE_ENV !== 'test'` and reachable; otherwise **per-process memory** |
| Multi-instance production | Memory fallback **does not share counters across API instances**. Upstash does. If REST is missing/down, two instances ≈ 2× the intended cap. Logged as `rate limit backend unavailable`. |

Turnstile: a clean `assertHuman` abstraction exists for **public booking**, not marketing signup. Wiring it to the marketing form needs a client widget, token on `POST /v1/public/signup-checkout`, and site-key injection into `apps/marketing`. **Deferred** — not required to prove this commercial path. Record for launch ops: add Turnstile to marketing signup before pointing real traffic, or accept IP/email hash limits + Upstash.

## 17. Files changed

- `apps/api/src/signup/sessionStatus.ts` (new)
- `apps/api/src/signup/sessionStatus.test.ts` (new)
- `apps/api/src/signup/routes.ts`
- `apps/marketing/src/lib/signupStatus.ts` (new)
- `apps/marketing/src/lib/signupStatus.test.ts` (new)
- `apps/marketing/src/pages/Success.tsx`
- `apps/marketing/src/App.test.tsx`
- `docs/qa/COMMERCIAL_E2E.md` (this file)

Local-only (not committed): `.env` `APP_BASE_URL` / `MARKETING_BASE_URL`; local GoTrue redirect allow-list.

### Verification commands (this machine)

- `pnpm --filter @gf/marketing test` — 14 passed
- `pnpm --filter @gf/api exec vitest run` signup / checkout / sessionStatus / stripe verify+webhook+eventLease / billing — 7 files passed
- `pnpm --filter @gf/api typecheck`
- `pnpm --filter @gf/web typecheck`
- `pnpm --filter @gf/marketing typecheck`
- `pnpm --filter @gf/marketing build`
- `pnpm --filter @gf/web build`
- `git diff --check`
- `pnpm lint:guards`

API integration tests re-seed the isolated test DB; Stripe TEST objects above remain the source of truth for this run.

## 18. Remaining blockers

### Full browser QA

- Growth activation/setup UI (skipped; Essential already proved claim + setup).
- `hasPaymentMethod` stays false until `subscription.default_payment_method` is copied onto `billing_accounts` — Billing copy said “尚未绑定银行卡” even though Stripe has `pm_1UAFwnJDnwqCtyJGEyo3VW3g` on the subscription.
- One unexplained 404 in the desk console after login.

### Staging deployment

- Confirm staging Stripe is TEST, webhook endpoint uses that environment’s `whsec_`, Price IDs match TEST Essential/Growth.
- Set `MARKETING_BASE_URL` and `APP_BASE_URL` to staging hosts (do not leave production defaults).
- Add staging desk `/activate` and `/reset-password` to Supabase Auth redirect allow-list.
- Do not point staging at the production Supabase project or live Stripe keys.
- Apply migrations 0072–0074 on staging if not already (DEV already has them; prod still called out in `docs/23`).
- Turnstile on marketing signup still deferred.
- `billing.changePlan` / `billing.buyAddon` local paid-state commands remain launch blockers from earlier batches (not exercised here; do not enable them as a substitute for Stripe).
