# Seed V2 Browser QA Findings

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


Date: 2026-08-30  
Pass type: remaining exploratory browser QA after QA-001…QA-006 repair, then final fix pass for QA-007 and QA-008  
Status: QA-001…QA-008 FIXED / VERIFIED. Open counted findings: none.

## Severity summary

| Severity | Open | Fixed |
| --- | ---: | ---: |
| P0 | 0 | 0 |
| P1 | 0 | 3 |
| P2 | 0 | 5 |
| P3 | 0 | 0 |

QA-001…QA-006 were not re-opened. QA-007 (support double-submit) and QA-008 (desk “Today”/“Yesterday” timezone mix) were repaired in the final fix pass. Test-runner selector failures, Seed V2 fixture limits, and intentional product behavior are not counted.

## Product defects

### QA-001 — P2 — “Save and continue” does not continue in SetupWizard

- **Scenario:** `growth_setup` SetupWizard profile/hours step.
- **Reproduction:** Reset and seed the isolated QA database; sign in as the scenario owner; complete the first setup step; select **Save and continue**.
- **Expected:** The successful save advances to the services step.
- **Actual:** The save succeeds, but the wizard remains on step 1. Selecting the separate **Next** control after the refetch advances normally.
- **Screenshot/trace:** [`artifacts/playwright/evidence/qa-001-save-and-continue-stays-on-step-one.png`](../../artifacts/playwright/evidence/qa-001-save-and-continue-stays-on-step-one.png)
- **Console/network evidence:** The setup save returned HTTP 201. No page exception or console error accompanied the failure.
- **Likely root cause:** The success callback calls `goTo(1)` before the setup-status query has refetched. The step-unlock predicate still reads the pre-save readiness state and rejects the transition.
- **Relevant files:** `apps/web/src/pages/SetupWizard.tsx`; the setup status/query and `StoreStepForm` save callback.
- **Recommended regression/fix:** Update or await the readiness state before navigating, then assert that one click on **Save and continue** changes the active step. A browser regression is present in `e2e/specs/auth-setup.spec.ts`.
- **Status:** **FIXED / VERIFIED.** Store-step save now advances to catalog without a second Next click. Playwright: Growth setup wizard test.

### QA-003 — P2 — Front-desk deep link executes owner-only settings queries and renders a fatal page

- **Scenario:** `role_frontdesk`, direct navigation to `/settings?tab=billing`.
- **Reproduction:** Sign in as the front-desk fixture user; open the billing settings deep link; reload it.
- **Expected:** The route/tab is hidden or rejected before privileged queries execute, with a stable permission-safe destination or access-denied state.
- **Actual:** The settings screen calls privileged endpoints, retries them, and replaces the entire page with `PERMISSION_DENIED` / “Failed to load system settings.”
- **Screenshot/trace:** [`artifacts/playwright/evidence/qa-003-frontdesk-settings-deep-link.png`](../../artifacts/playwright/evidence/qa-003-frontdesk-settings-deep-link.png)
- **Console/network evidence:** `GET /v1/desk/settings` and `GET /v1/desk/billing` returned expected HTTP 403 responses more than once because the queries retried. The browser collector correctly treated these as expected permission responses for this test.
- **Likely root cause:** Navigation permissions and query enablement are not aligned: the settings route renders and starts owner-only queries before enforcing the tab/route permission.
- **Relevant files:** the web router/sidebar permission configuration, `apps/web/src/pages/Settings.tsx`, and its settings/billing query hooks.
- **Recommended regression/fix:** Add a route-level permission guard and disable unauthorized queries. Retain a direct-link plus reload regression in `e2e/specs/billing-permissions.spec.ts`.
- **Status:** **FIXED / VERIFIED.** Front-desk `/settings?tab=billing` is rejected before owner-only queries run and shows a permission-safe state, including after reload. Playwright: front-desk billing deep-link test.

### QA-004 — P1 — Paid Stripe subscription can remain locally represented as “no payment method” (KNOWN-1)

- **Scenario:** `growth_active` billing UI, corroborated by the prior real Stripe TEST commercial E2E.
- **Reproduction:** Complete a Stripe TEST subscription whose subscription/default invoice payment method is set; allow subscription synchronization; open the desk billing screen.
- **Expected:** `billing_accounts.default_payment_method_id` reflects Stripe's paid-state payment method and the UI shows a card on file.
- **Actual:** The Growth subscription is active, while the billing UI shows **No payment method** / **Add payment method**. The prior commercial run recorded a Stripe-side payment method with a null local default-payment-method field; the Seed browser state reproduces the resulting UI condition.
- **Screenshot/trace:** [`artifacts/playwright/evidence/known-1-growth-billing-no-card.png`](../../artifacts/playwright/evidence/known-1-growth-billing-no-card.png)
- **Console/network evidence:** No browser 4xx/5xx is required to produce the inconsistent state. A fresh live Stripe re-query was not possible after the QA reset removed the earlier commercial fixture, so the conclusion combines the retained commercial evidence with current source/browser evidence.
- **Likely root cause:** `syncSubscription()` synchronizes plan, status, customer/subscription IDs, periods, trial, and source, but does not synchronize `default_payment_method`. The local field is written only through the separate setup-mode `billing.savePaymentMethod` path.
- **Relevant files:** `apps/api/src/stripe/routes.ts`, billing command/event handlers that write `billing_accounts`, and `apps/web/src/features/billing/BillingPanel.tsx`.
- **Recommended regression/fix:** Add a real Stripe TEST webhook/subscription-sync regression that asserts both Stripe truth and the local payment-method projection before asserting the browser card state.
- **Status:** **FIXED / VERIFIED.** Root cause: `syncSubscription()` wrote plan/status/ids but not Stripe's `default_payment_method`. The webhook now projects that id through `billing.savePaymentMethod`. Seed V2 paid shops write the same columns via `applySavedPaymentMethodFixture`. Playwright: Growth active billing shows `Visa ···· 4242`. Webhook tenant tests cover present/absent Stripe PMs.

### QA-005 — P1 — Gift-card issue reports success while the refetched list remains empty

- **Scenario:** `busy_shop`, Marketing → Gift card sales → Issue a gift card.
- **Reproduction:** Issue a $100 face-value gift card for an $80 sale; supply purchaser/recipient names; confirm issuance.
- **Expected:** The dialog closes, the newly issued card appears in the list, and its code can be used by inline checkout.
- **Actual:** The command returns success and a toast containing a new card number, but the dialog remains open and the refetched page still reports **Total 0 cards** / **No gift card records**. This blocked the automated inline gift-card checkout continuation.
- **Screenshot/trace:** [`test-failed-1.png`](../../artifacts/playwright/test-results/operations-daily-operation-bd026-nd-inline-checkout-complete-chromium/test-failed-1.png); [`trace.zip`](../../artifacts/playwright/test-results/operations-daily-operation-bd026-nd-inline-checkout-complete-chromium/trace.zip)
- **Console/network evidence:** `POST /v1/commands/giftcard.issue` returned HTTP 201. The immediate `GET /v1/desk/giftcards` refetch returned HTTP 200 but rendered zero cards. There was no console exception.
- **Likely root cause:** The command write and gift-card read model/query are not becoming consistent for the active membership/location. Separately, the successful mutation path does not dismiss the issue dialog. The evidence does not yet distinguish a persistence/projection filter defect from a response-shape/cache defect.
- **Relevant files:** `apps/web/src/pages/Marketing.tsx`, `apps/web/src/features/marketing/api.ts`, `apps/api/src/routes/marketing.ts`, the `giftcard.issue` command handler, and `apps/api/src/queries/giftcard.ts`.
- **Recommended regression/fix:** First assert the inserted row and tenant/location keys at the command boundary, then assert that the list endpoint returns it and that the dialog closes. Resume `e2e/specs/operations.spec.ts` only after that invariant passes.
- **Status:** **FIXED / VERIFIED.** Root cause: `GET /v1/desk/giftcards` returned `{ total, rows }` while the Marketing UI read `giftCards`. The list now returns both keys. Issue dialog closes after a successful refetch. Playwright: issue → list → verify code → ticket.pay 201.

### QA-006 — P1 — No customer-facing support-request submission surface was found

- **Scenario:** Customer/owner support request → platform handling.
- **Reproduction:** Sign in to the desk as an owner and inspect the complete navigation/available routes for a support-request entry; search the implemented desk surfaces for a support submission form.
- **Expected:** A tenant user can create a support request that an active platform operator can then handle.
- **Actual:** No Support navigation entry or desk submission surface was present in the inspected app. The platform-side handling capability and seeded open-request data do not supply the missing customer action.
- **Screenshot/trace:** The full desk sidebar is visible in [`test-failed-1.png`](../../artifacts/playwright/test-results/operations-daily-operation-bd026-nd-inline-checkout-complete-chromium/test-failed-1.png), with the associated [`trace.zip`](../../artifacts/playwright/test-results/operations-daily-operation-bd026-nd-inline-checkout-complete-chromium/trace.zip).
- **Console/network evidence:** Not applicable: there is no browser control from which to originate the request. No speculative endpoint call was made.
- **Likely root cause:** Platform support handling was implemented without a corresponding desk route/navigation/form for request creation.
- **Relevant files:** the web router and sidebar configuration, desk support feature/page files (absent in the inspected implementation), and the platform support-request page/API.
- **Recommended regression/fix:** Add a tenant submission surface backed by the existing command/API boundary, then test creation in the desk and state transition in the platform app. The authored test remains incomplete in `e2e/specs/platform-marketing-api.spec.ts`.
- **Status:** **FIXED / VERIFIED.** Desk `/support` submits `support.submitRequest` (subject/message/category) with success/error state. Playwright: desk submit then platform note + resolve.

## Seed V2 / test-data defect

### QA-002 — P2 — `busy_shop` seeds an “in service” visit that cannot be completed

- **Scenario:** `busy_shop`, Emily Stone's pre-seeded in-service queue card.
- **Reproduction:** Reset/seed `busy_shop`; sign in; open Operations Board; select **Finish and calculate the bill** for Emily Stone; confirm completion.
- **Expected:** A visit presented as in service has an active ticket item and can transition to awaiting payment.
- **Actual:** The UI reports that there is no active service to finish, and Emily remains in service.
- **Screenshot/trace:** [`artifacts/playwright/evidence/qa-002-seeded-in-service-cannot-complete.png`](../../artifacts/playwright/evidence/qa-002-seeded-in-service-cannot-complete.png)
- **Console/network evidence:** No unexpected console error or 4xx/5xx was observed; the client-side completion orchestration rejects the internally inconsistent lifecycle state.
- **Likely root cause:** `packages/db/src/qa/lifecycle.ts` creates the appointment/item as `in_service` and opens a ticket, but the seeded `ticket_items.started_at` value is not populated. `apps/web/src/features/queue/completeService.ts` requires a started, unfinished ticket item.
- **Relevant files:** `packages/db/src/qa/lifecycle.ts`, `packages/db/src/qa/scenarios.ts`, and `apps/web/src/features/queue/completeService.ts`.
- **Recommended regression/fix:** Seed through the production start-service transition or populate all equivalent invariants. Extend Seed V2 sanity tests to require at least one completable started ticket item for every in-service visit.
- **Status:** **FIXED / VERIFIED.** `busy_shop` in-service tickets now have `tickets.status=in_service` and `ticket_items.started_at` set, matching `ticket.startItem`. Seed V2 sanity asserts every in-service visit has a started unfinished ticket item. Playwright: Emily Stone finishes to awaiting payment.

### QA-007 — P2 — Support request double-submit creates two tickets

- **Scenario:** `support_request_open`, desk `/support`.
- **Reproduction:** Sign in as the scenario owner; open Support; fill subject and message; click **Submit request** twice before the first response returns.
- **Expected:** The second click is ignored while `isPending` is true, so one `support.submitRequest` command is sent and one request is created.
- **Actual:** Two `POST /v1/commands/support.submitRequest` calls both returned HTTP 201. Two success toasts remained: “Support request submitted.” The submit button is disabled only after React state commits, which is after both clicks have already been queued.
- **Screenshot/trace:** [`artifacts/playwright/test-results/remaining-browser-qa-remai-00eab--error-states-stay-coherent-chromium/test-failed-1.png`](../../artifacts/playwright/test-results/remaining-browser-qa-remai-00eab--error-states-stay-coherent-chromium/test-failed-1.png); network: req-2r and req-2s both 201.
- **Console/network evidence:** Two parallel POSTs to `/v1/commands/support.submitRequest` completed in ~29ms each with status 201. No 4xx/5xx.
- **Likely root cause:** `Support.tsx` `handleSubmit` is async and the button’s `disabled={submit.isPending}` does not cover the interval between the first click and the mutation pending flag. There is no client idempotency key.
- **Relevant files:** `apps/web/src/pages/Support.tsx`; `apps/web/src/features/support/api.ts`; `apps/web/src/components/ui/Modal.tsx` `ConfirmDialog` has the same fire-and-forget pattern for other confirms.
- **Recommended regression/fix:** Disable on the first press (local submitting flag or GuardedButton), send an idempotency key, and assert a double-click issues one command. Playwright: `e2e/specs/remaining-browser-qa.spec.ts` support history/double-submit test.
- **Status:** **FIXED / VERIFIED.** `Support.tsx` sets a ref lock synchronously on the first click (not `isPending`) and sends a per-submission `Idempotency-Key`. A second click in the same tick is ignored; a retried POST with that key cannot insert twice. Unit: rapid double-click. Playwright: support history/double-submit test expects one POST.

### QA-008 — P2 — Desk “Today” / “Yesterday” mix UTC, browser local, and shop timezone

- **Scenario:** `growth_active` (America/New_York) and `multi_location_owner` West Side Spa (America/Los_Angeles). Playwright `timezoneId` is `America/New_York`. Clock frozen at UTC midnight-crossing instants.
- **Reproduction:**
  1. NY shop at `2026-08-31T00:15:00.000Z` (20:15 EDT on 2026-08-30). Open Rotation; note the date input. Open Day Close and click **Yesterday**.
  2. Switch to West Side Spa at `2026-08-31T04:30:00.000Z` (21:30 PDT on 2026-08-30 / 00:30 EDT on 2026-08-31). Open Schedule and click **Today**.
- **Expected:** Every desk “today” control uses the shop IANA timezone, matching `apps/web/src/lib/time.ts` and `GET /v1/desk/day` `businessDate`. NY evening today = `2026-08-30`; West shop today at that second instant = `2026-08-30`; Day Close Yesterday = previous shop business date (`2026-08-29` for the NY shop).
- **Actual:**
  | Surface | Clock | Shop today | UI date |
  | --- | --- | --- | --- |
  | Dashboard / Day Close **Today** | NY 20:15 | 2026-08-30 | 2026-08-30 (correct) |
  | Rotation date input / **Today, live** | NY 20:15 | 2026-08-30 | **2026-08-31** (UTC) |
  | Day Close **Yesterday** | NY 20:15 | yesterday 2026-08-29 | **2026-08-30** |
  | Schedule **Today** click | West 21:30 PDT | 2026-08-30 | **2026-08-31** (browser NY) |
  | Rotation | West 21:30 PDT | 2026-08-30 | **2026-08-31** (UTC) |

  Independently, the unfrozen remaining-QA host was already `2026-08-31T02:09Z` (~22:09 EDT). After login the desk issued `GET /v1/desk/day?date=2026-08-31` while the NY shop business date was still `2026-08-30`.
- **Screenshot/trace:** [`artifacts/playwright/evidence/timezone-ny-evening.json`](../../artifacts/playwright/evidence/timezone-ny-evening.json); [`artifacts/playwright/evidence/timezone-west-shop-today.json`](../../artifacts/playwright/evidence/timezone-west-shop-today.json); [`artifacts/playwright/evidence/timezone-ny-evening-rotation.png`](../../artifacts/playwright/evidence/timezone-ny-evening-rotation.png); [`artifacts/playwright/evidence/timezone-west-shop-today.png`](../../artifacts/playwright/evidence/timezone-west-shop-today.png).
- **Console/network evidence:** `GET /v1/desk/dayclose?date=2026-08-30` after Day Close **Today** (shop TZ). Rotation `<input type="date">` value `2026-08-31`. No HTTP error is required.
- **Likely root cause:** Inconsistent “today” writers:
  - Rotation: `new Date().toISOString().slice(0, 10)` (UTC calendar date) in `apps/web/src/pages/Rotation.tsx`.
  - Schedule **Today** button: `realToday.getFullYear()/getMonth()/getDate()` (browser local) in `apps/web/src/pages/Schedule.tsx`. Initial `currentDate` in `ScheduleContext` uses shop TZ, so the mismatch appears after clicking **Today**.
  - Day Close **Yesterday**: `new Date(); setDate(getDate()-1); toISOString().slice(0,10)` (UTC) in `apps/web/src/pages/DayClose.tsx`. **Today** uses `instantToWallDate` (correct).
  - `ScheduleProvider` first paint falls back to UTC ISO when `context.timezone` is not yet available, which explains the live `?date=2026-08-31` request at 22:09 Eastern.
- **Relevant files:** `apps/web/src/pages/Rotation.tsx`; `apps/web/src/pages/Schedule.tsx`; `apps/web/src/pages/DayClose.tsx`; `apps/web/src/context/ScheduleContext.tsx`; `apps/web/src/lib/time.ts` (the canonical rule these pages violate).
- **Recommended regression/fix:** Drive every today/yesterday control through `instantToWallDate(..., context.timezone)` and shift calendar dates with `shiftDate`. Keep the Playwright clock cases in `e2e/specs/remaining-browser-qa.spec.ts`.
- **Status:** **FIXED / VERIFIED.** Rotation Today, Schedule Today (and the now-line), Day Close Yesterday/prev/next, and ScheduleContext initial date all use `instantToWallDate` / `shiftDate` from `apps/web/src/lib/time.ts`. No UTC ISO date fallback while timezone is loading. Unit tests cover NY/LA midnight crossings and DST wall dates. Playwright clock cases for NY evening and West shop remain.

## Investigations and non-findings

- **KNOWN-1:** Confirmed; recorded as QA-004. Still FIXED.
- **KNOWN-2:** Re-attempted with Playwright network capture after desk login on `growth_active` (dashboard → queue → schedule → billing). Unexpected HTTP 4xx list was empty. Playwright Chromium did not request `/favicon.ico`. The original commercial-E2E note was “one unexplained 404 (resource load)” with no URL retained. The desk `index.html` still has no `favicon.ico` (only `apple-touch-icon` `/icon-192.png` and `/manifest.webmanifest`). A real Chrome tab commonly requests `/favicon.ico` and Vite would 404 it. That remains the most likely original resource-load 404; it is an environment/asset observation, **not counted**. No desk API 404 was reproduced.
- **KNOWN-3:** Completed. Growth SetupWizard now runs end-to-end in `e2e/specs/auth-setup.spec.ts` (profile/hours → catalog → staff → launch → dashboard reload → Growth billing). Step form copy is still hardcoded Chinese; that is existing i18n scope, not a new counted defect.
- **Multi-location isolation:** Spot-regression still passed in the authored spec (Store A names absent on Store B; back/forward/reload keep West). West **Today** click is QA-008, not a tenant-leak.
- **10DLC customer submit:** `growth_active` Settings → 10DLC filled legal/EIN/rep fields, confirmed, reloaded as **Pending GenieFront review**. Evidence: [`artifacts/playwright/evidence/10dlc-customer-submitted.png`](../../artifacts/playwright/evidence/10dlc-customer-submitted.png). Platform **Mark under review** remains covered by `ten_dlc_pending` (Seed V2 wipes other V2 tenants, so the same row cannot be reviewed in a second scenario). Lotus `ops@maildrop.cc` did not complete a session in this isolated GoTrue; that is a fixture/login limitation, not a missing desk surface.
- **Billing remaining matrix:** Growth $50 AI credit and $50 voice-minute buttons are exposed; mocked `POST /v1/billing/topup` sent `credit` then `voice_minute` and showed “Payment confirmed.” Auto-topup enable persists across reload and can be disabled. Threshold values (50 credits / 20 minutes) are displayed; there is no editor. API `billing.setAutoTopup` accepts `thresholdUnits`; the UI always resubmits the current threshold. Treated as **intentional** (enable/disable only) unless a spec later requires an editable threshold.
- **Gift cards not paying tips:** Still treated as **intentional**. Checkout regression uses **No Tip** + gift card.
- **past_due:** Login and billing recovery copy remain available. Catalog-write freeze was not independently proven in the remaining spec (service-name field was not a stable labeled control); API `SUBSCRIPTION_PAST_DUE` coverage is the existing command-bus suite.
- **Marketing cancel:** `/signup/cancel` says “Checkout canceled” / “No shop was created” and returns to pricing. Success-session invalid/confirmed paths remain in `platform-marketing-api.spec.ts`. Live Stripe Checkout was not duplicated.
- **Console/network:** Remaining-QA KNOWN-2 capture found no unexplained 4xx. Double-submit 201s are QA-007. Expected 403s remain in the front-desk billing deep-link test.

---

# Independent final audit — AUD-01 … AUD-13

Date: 2026-08-31
Pass type: independent re-audit of the whole system, then a full fix pass in the same session.
Status: **AUD-01 … AUD-13 FIXED / VERIFIED.** Open counted findings: none.

## Severity summary

| Severity | Open | Fixed |
| --- | ---: | ---: |
| P0 | 0 | 1 |
| P1 | 0 | 2 |
| P2 | 0 | 7 |
| P3 | 0 | 3 |

## AUD-01 — P0 — Any shop owner could grant themselves a paid plan and unlimited AI credits

- **Reproduction (proven live before the fix):** with an ordinary owner JWT and their own
  `X-Membership-Id`, `POST /v1/commands/billing.syncSubscription`
  `{"plan":"growth","subscriptionStatus":"active","currentPeriodEnd":"2099-01-01T00:00:00.000Z"}`
  returned 201 and flipped the row to `growth | active | 2099-01-01`, while the real Stripe
  subscription stayed Essential/trialing. A second call to `billing.recordTopup`
  `{"unit":"credit","units":99999,"paidCents":1,"stripePaymentIntentId":null}` minted 99,999 credits.
- **Root cause:** `POST /v1/commands/:name` executes any registered command; the bus only checked
  `def.permission`, and `billing.syncSubscription` declares `billing.manage`, which the `owner`
  preset holds. `ai: { exposed: false }` was mistaken for an internal-only marker — it only
  suppresses AI tool generation and has never affected HTTP routing.
- **Why tests did not catch it:** `billing.test.ts` builds its context from a real **owner**
  membership and calls `dispatch('billing.syncSubscription', …)` ~30 times, all green — the suite
  performed the exploit as its standard setup. `TEST_DATA_AUDIT.md` §UPDATE prescribed exactly that
  call as the *approved* replacement for "casual paid-state flips", codifying the hole as practice.
- **Fix:** `system: true` on `CommandDef`, enforced at two fail-closed layers (see
  `docs/audit/CURRENT_STATE.md`). 15 commands marked. Test seam `apps/api/src/test/systemDispatch.ts`
  (`dispatchSystem`) separates "a tenant did this" from "an external system reported this";
  every fixture that conflated them was rewritten.
- **Files:** `packages/contracts/src/command.ts`, `apps/api/src/bus.ts`, `apps/api/src/server.ts`,
  `packages/contracts/src/commands/{billing,ai,phone,blueprint,analytics,setup,notifications,storefront}.ts`,
  and every server-side dispatch site (now declaring `systemOrigin`).
- **Regression:** `apps/api/src/systemOnly.test.ts` — iterates the **whole registry**, so a future
  internal command that forgets `system: true` fails the suite. Also replays both original payloads.
- **Status: FIXED / VERIFIED.** Re-run post-fix with a full-permission owner: both payloads return
  `PERMISSION_DENIED / system_only_command`, the billing row is byte-identical afterwards, and the
  same command via `systemOrigin: 'stripe_webhook'` still succeeds.

## AUD-02 — P1 — Webhook tenant resolution and the Stripe portal trusted a tenant-writable column

- **Root cause:** `billing_accounts.stripe_customer_id` / `stripe_subscription_id` were read as
  system truth by `gf_billing_tenant_for_stripe_refs` and by `POST /v1/billing/portal-session`,
  yet (via AUD-01) a tenant could write them. Writing a victim's `sub_…` made their invoice events
  resolve to no tenant and be silently swallowed with HTTP 200; writing a victim's `cus_…` opened a
  Stripe Customer Portal session over the victim's account.
- **Fix:** (a) AUD-01 closed the write path; (b) `sql/0080` + `sql/0081` enforce **one Stripe id ↔
  one org** with a `SECURITY DEFINER` trigger; (c) `assertStripeCustomerBelongsTo()` re-reads
  `customer.metadata.gf_location_id` from Stripe before opening a portal session or charging a
  top-up — mismatch is refused, *missing* metadata is allowed with a warn so pre-backfill customers
  are not locked out; (d) `resolveWebhookTenant` now handles `payment_method.*` events, reading the
  prior customer from `data.previous_attributes` (a `detached` event has `customer: null`).
- **Two things the fix pass got wrong first, both caught by tests, both worth recording:**
  1. A plain unique index on `stripe_customer_id` broke **legitimate multi-store billing** — one
     owner deliberately shares one Stripe customer and one subscription across their locations
     (`handlers/setup.ts`). Corrected to a per-org functional dependency in `sql/0080`.
  2. That trigger was ordinary `plpgsql`, so it ran as `app_user` under RLS and its
     `exists (… org_id <> new.org_id)` was **always false** — a check that looked present and did
     nothing. Only the `app_user`-identity test exposed it; manual `psql` verification as `postgres`
     could not. Fixed in `sql/0081` with `SECURITY DEFINER`.
- **Also fixed in passing:** multi-store orgs' invoice events never resolved a tenant at all
  (`count(*) > 1 → return null`), so their subscription state silently stopped updating. Same-org
  multi-row is no longer treated as ambiguity; cross-org still refuses to guess.
- **Regression:** `stripe/webhook.tenant.test.ts` — cross-org sharing rejected by the DB;
  same-org sharing resolves to one anchor location; unknown ids still return null.
- **Status: FIXED / VERIFIED.**

## AUD-03 — P1 — Anthropic was called before any quota, rate, or subscription check

- **Root cause:** order was permissions → **model call** → `ai.recordAssist`. The past-due freeze
  lives inside `dispatch()`, i.e. *after* the spend; `chargeQuota` deliberately allows a negative
  balance with no admission counterpart; and no AI route had a rate limit. A `past_due` tenant could
  burn real tokens and fail only at the accounting step, leaving the spend **unrecorded**.
- **Fix:** `apps/api/src/billing/aiAdmission.ts`, called immediately before all seven model call
  sites. New codes `AI_QUOTA_EXHAUSTED` (402) / `AI_RATE_LIMITED` (429), wired through the web error
  map and five locales. Metering semantics unchanged.
- **Regression:** `apps/api/src/aiAdmission.test.ts` (8 cases) + `scripts/check-ai-gate.mjs` in
  `lint:guards`, which verifies each model call has a gate **above it** rather than comparing counts.
  The guard immediately found an ungated second `askCopilot` (the streaming SSE path).
- **Status: FIXED / VERIFIED.** Post-fix: `past_due` → `SUBSCRIPTION_PAST_DUE {reason:'ai_blocked'}`
  and exhausted quota → `AI_QUOTA_EXHAUSTED`, both **before** any network call.

## AUD-04 — P2 — Four live desk routes wrote business tables directly

- Routes: `POST /v1/desk/appointments/:id/service-brief`, `POST /v1/desk/appointments/:id/customer`,
  `POST /v1/desk/forms/re-submit`, `POST /v1/storefront/:id/generate`. None wrote `audit_log`, none
  were idempotent, none were subject to the past-due freeze. The health-form route let a signed
  intake form be rewritten with no before/after record.
- **Root cause:** `lint-guards.sh` enforced five constitutional rules but had **no check for rule #1**
  — the one rule that had no executable test.
- **Fix:** new commands `appointment.saveServiceBrief`, `appointment.assignCustomer`,
  `storefront.saveDrafts`; form re-submit routed through the existing `form.submit` writer with a new
  `supersedePrevious` flag (which also fixed two latent bugs there: the old route stored the
  **signature image in plaintext** and hardcoded `template_version = 1`).
- **Regression:** `auditFixes.test.ts` asserts an `audit_log` row now exists; **new lint guard #9**
  fails on any business-table write outside `handlers/`. Both guards were verified to fire by
  injecting a violation and observing a red build.
- **Status: FIXED / VERIFIED.**

## AUD-05 — P2 — `appointments.customer_id` accepted another organization's customer

- **Root cause:** FK was `references customers(id)` with no org predicate, and PostgreSQL FK checks
  run as table owner, **bypassing RLS**. A cross-org UUID was accepted, then filtered to NULL on read
  — the customer silently vanished from every view.
- **Fix:** ownership validation in `appointment.assignCustomer`, plus `sql/0076` composite FK
  `(org_id, customer_id) → customers (org_id, id)` on `appointments` and `walkin_queue`.
- **Regression:** `auditFixes.test.ts` (cross-org rejected, same-org accepted as control). DB level
  proven directly: control insert accepted, cross-org insert `foreign_key_violation`.
- **Status: FIXED / VERIFIED.**

## AUD-06 — P2 — Notification commands had no permission; three mutated shop-wide state

- `notification.markRead` / `markAllRead` / `delete` / `clearRead` / `create` all declared **no**
  permission. `delete` and `clearRead` operate on `location_id` with no recipient predicate, so any
  technician could erase the shop's shared feed. `create` allowed a shop-wide broadcast with
  attacker-chosen title/level and `ai.confirm: 'never'`.
- **Fix:** `appointment.read` on the read-marking pair (every role has it), `settings.manage` on both
  destructive ones, and `system: true` + `settings.manage` + `confirm: 'always'` on `create`
  (the browser never called it). `actionUrl` constrained to a relative path.
- **Also fixed:** `staff.setPin` scoped its update by `membership_id` only, so a `staff.manage`
  holder at one location could set a PIN at a sibling location in the same org. Now `location`-scoped.
- **Regression:** `auditFixes.test.ts` — technician denied delete/clear, still allowed mark-read,
  `notification.create` refused as system-only.
- **Status: FIXED / VERIFIED.**

## AUD-07 — P2 — The local card-on-file was never cleared when Stripe had none

- QA-004's fix was one-directional (`if (!resolved) return`). Removing the card in the Stripe Customer
  Portal left the desk showing "Visa ···· 4242" and auto-topup charging a detached method.
- **Why the earlier test missed it:** the "does not invent a payment method" case **nulls the local
  columns first**, so it asserted null-stays-null — never the populated → empty transition.
- **Fix:** two-level resolution (subscription → customer `invoice_settings`) so setup-mode cards are
  not wiped, explicit clear when Stripe has neither, `undefined` on a Stripe read failure meaning
  *leave it alone* (a network blip must not erase the card), and a `payment_method.detached` handler
  that clears only if the detached id is the current one (Stripe attaches the new card before
  detaching the old one during a swap).
- **Status: FIXED / VERIFIED.**

## AUD-08 — P2 — Support was write-only for the customer, and internal notes were tenant-readable

- QA-006 added a submit form and stopped there. The platform can set `waiting` ("waiting on the
  customer") with no channel that reaches them. Separately `support_request_notes` — commented
  "Not shown to customers" — carried an `org_id = app_org_id()` policy with `grant select to app_user`;
  only the absence of a desk query kept it private.
- **Fix:** `sql/0077` replaces the notes policy with `operator_only`
  (`gf_platform_operator_role() is not null`) and adds `support_requests.last_operator_update_at`;
  new `GET /v1/desk/support/requests` (main table only, never joins notes) and a history section on
  the desk Support page showing status and "support updated".
- **Regression:** `packages/db/src/rls.test.ts` asserts **every** policy on `support_request_notes`
  requires operator identity; `Support.test.tsx` asserts the customer sees status and that no note
  text renders. Proven at the DB level: a tenant `app_user` context reads **0** note rows while an
  active operator context reads them normally.
- **Status: FIXED / VERIFIED.**

## AUD-09 — P2 — `command_idempotency` grew without bound

- Every desk write inserts a row with the full `result_json`; the table had an `at` column but no TTL,
  partitioning, or purge anywhere in production code. `01-ARCHITECTURE` §4 lists four tables for
  future partitioning and omits the fastest-growing one.
- **Fix:** `sql/0078` `gf_purge_command_idempotency(hours)` with a **24-hour floor enforced in the
  database**, plus `apps/api/src/ops/retention.ts` scheduled hourly from `main.ts` (not `buildServer`,
  so tests do not spawn timers). Logs every run including zero-row runs.
- **Regression:** `auditFixes.test.ts` — a within-window key still replays after a purge; a row aged
  past the window is removed; passing `0` cannot delete within-window rows.
- **Status: FIXED / VERIFIED.**

## AUD-10 — P3 — `sms_inbound` was readable across all tenants

- Policy was `using (true)` with `grant select to app_user`, so any tenant context could read every
  shop's inbound message bodies. Only `queries/smsInbound.ts`'s own discipline prevented a leak.
- **Fix:** `sql/0079` splits the policy — `INSERT with check (true)` (the webhook genuinely has no
  tenant context) and `SELECT` restricted to numbers belonging to this org's customers.
- **Status: FIXED / VERIFIED.** Proven at the RLS layer: with two seeded messages, the nail org sees
  only `AUD10 NAIL-ORG SECRET` and the spa org only `AUD10 SPA-ORG SECRET`.

## AUD-11 — P3 — PIN hashing was single-round SHA-256 with one global salt

- `sha256('gf_pin_salt_' + pin)` over a 4–6 digit space: one rainbow table breaks every PIN in the
  system, and identical PINs produced identical hashes.
- **⭐ Found while fixing:** the writer (`staff.setPin`, global salt) and the verifier
  (`assertPin`, `sha256(membershipId + ':' + pin)`) used **different, mutually incompatible schemes**.
  A technician who set a PIN could never clock in — every attempt returned "PIN 不对". Each half looked
  correct in isolation; only reading both together showed it.
- **Fix:** `apps/api/src/auth/pin.ts` — scrypt (N=32768, r=8, p=1, explicit 64MB `maxmem`), 16-byte
  random per-row salt, parameters embedded in the stored string. One module now owns both write and
  verify. Legacy hashes of **both** historical shapes still verify and are transparently rehashed on
  next use, so no shop has to reset PINs.
- **Regression:** `auditFixes.test.ts` — same PIN yields different hashes; the stored value is not the
  legacy digest; both legacy shapes verify with `needsRehash: true`.
- **Status: FIXED / VERIFIED.**

## AUD-12 — P3 — The offline IndexedDB snapshot survived sign-out

- Every successful GET is cached (appointments, queue, tickets — with customer names and phone
  numbers). Keys include `membershipId`, so the app cannot cross-read; but nothing ever deleted the
  store, leaving plaintext customer data on shared front-desk machines indefinitely — in a product
  that masks phone digits from its own technicians.
- **Fix:** `clearCache()` in `apps/web/src/lib/offline.ts` deletes the whole database (not per-key —
  enumerating keys at sign-out is exactly the wrong moment), called from `signOut` **before**
  `supabase.auth.signOut()` so it completes before components unmount; `queryClient.clear()` and the
  stored membership id are cleared alongside.
- **Status: FIXED / VERIFIED.**

---

## AUD-13 — P2 — Desk "today" ignored the business-day cutoff (incomplete QA-008 fix)

- **Product decision (2026-08-31):** every operational Desk concept of Today / Yesterday uses the
  **location business day, including the configured `business_day_cutoff`** — not calendar midnight.

  ```
  America/New_York, cutoff 04:00
    2026-08-31 01:30 EDT  →  Business Today = 2026-08-30, Business Yesterday = 2026-08-29
    2026-08-31 04:00 EDT  →  Business Today = 2026-08-31
  ```

- **Original defect:** QA-008 moved every desk date control from UTC / browser-local to
  `instantToWallDate(shopTimezone)`. That fixed the *timezone* half and left the *cutoff* half:
  the API is cutoff-aware (`GET /v1/desk/day` returns a `businessDate`), the desk was not.
  They agreed for twenty hours a day and disagreed for the other four — which are precisely the
  hours a front desk closes out. The visible failure was Day Close showing "Trading today (open)"
  with all zeros at 01:30 while the night's real money sat under the previous date, so the desk
  **could not finalize the day it had just finished trading**.

- **Why the existing clock tests missed it:** both QA-008 Playwright cases freeze the clock at
  20:15 and 21:30 — *after* the cutoff, where the business day and the shop calendar day are equal.
  Either implementation passes there. Those two tests have been retitled to say what they actually
  guard, with a note pointing at the cutoff window.

- **Root cause:** `/v1/me/context` never sent `business_day_cutoff`, so the web physically could not
  compute a business date. Every surface independently fell back to the shop calendar day.

- **Fix:**
  - `GET /v1/me/context` now returns `businessDayCutoff` (`HH:MM`; falls back to `00:00`, i.e. the
    previous calendar-day behaviour, if the column is somehow unreadable).
  - `apps/web/src/lib/time.ts` gains `businessToday()` / `businessDateAt()` / `useBusinessDay()`,
    delegating to **`businessDateOf` from `@gf/scheduling` — the same function the API uses.**
    No second date implementation was introduced; a parallel one would diverge on the two DST days.
  - Migrated to `useBusinessDay()`: `ScheduleContext` (shared date navigation), Dashboard, Schedule
    (including the Today button, the month-grid highlight and the week header), Rotation
    (Today + Yesterday), Queue/operations board, Day Close (Today + Yesterday + prev/next),
    Layout's schedule nav, and BusinessData's report range (which was still raw
    `toISOString().slice(0, 10)` — UTC, so "last 7 days" already included a future day every
    evening after 20:00 Eastern).
  - `useBusinessDay()` returns `ready: false` until the session has both timezone and cutoff, so no
    surface fires a request with a guessed `?date=` — the tail QA-008 left behind.

- **Regression:**
  - `apps/web/src/lib/time.test.ts` — 26 cases: NY before / at / after cutoff, NY yesterday,
    LA before cutoff, two shops in different business days at the same instant, cutoff 03:00 vs
    04:00 disagreeing at 03:30, the `00:00` fallback, DST spring-forward (including a cutoff that
    lands inside the hour that does not exist, asserted to flip exactly once), DST fall-back
    (the repeated hour resolving to one business day, and the 25-hour day's both edges), and an
    equivalence check against the server's `businessDateOf`.
  - `apps/api/src/auditFixes.test.ts` — pins the `/v1/me/context` contract and the shared judge.
  - `e2e/specs/business-day.spec.ts` — 3 browser cases with the clock frozen **inside** the cutoff
    window: NY before cutoff (Rotation / Schedule / Schedule-Today / Day Close all on 2026-08-30,
    Yesterday on 2026-08-29), NY after cutoff, and LA before its own 03:00 cutoff with the browser
    in New York. Each asserts up front that the shop *calendar* day differs from the business day,
    so the test cannot silently degrade into the QA-008 window where both implementations agree.

- **Status: FIXED / VERIFIED.** Playwright 34/34 (31 prior + 3 new); `operations.spec.ts:57`
  "counted day closes and remains closed after reload" — the test that exposed this — now passes.

## Fixed in passing — seed anchored to the wrong day

`packages/db/src/seed.ts` `getDatesRange()` anchored on the **calendar** date, so between local
midnight and the 04:00 cutoff it marked the current business day `day_closes.status = 'closed'`.
Any test writing "today" in that window hit `business day … is closed` — **35 failures across
kiosk / core_loop / notify / phone**, green by day and red at night, with failure messages pointing
at business rules rather than at the fixture. Now anchored to the business day (4-hour rollback).
Verified: the same 35 tests fail at HEAD and pass after the change.
