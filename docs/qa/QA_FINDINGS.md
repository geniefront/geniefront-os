# Seed V2 Browser QA Findings

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
- **10DLC customer submit:** `growth_active` Settings → 10DLC filled legal/EIN/rep fields, confirmed, reloaded as **Pending GenieFront review**. Evidence: [`artifacts/playwright/evidence/10dlc-customer-submitted.png`](../../artifacts/playwright/evidence/10dlc-customer-submitted.png). Platform **Mark under review** remains covered by `ten_dlc_pending` (Seed V2 wipes other V2 tenants, so the same row cannot be reviewed in a second scenario). Lotus `ops@geniefront.test` did not complete a session in this isolated GoTrue; that is a fixture/login limitation, not a missing desk surface.
- **Billing remaining matrix:** Growth $50 AI credit and $50 voice-minute buttons are exposed; mocked `POST /v1/billing/topup` sent `credit` then `voice_minute` and showed “Payment confirmed.” Auto-topup enable persists across reload and can be disabled. Threshold values (50 credits / 20 minutes) are displayed; there is no editor. API `billing.setAutoTopup` accepts `thresholdUnits`; the UI always resubmits the current threshold. Treated as **intentional** (enable/disable only) unless a spec later requires an editable threshold.
- **Gift cards not paying tips:** Still treated as **intentional**. Checkout regression uses **No Tip** + gift card.
- **past_due:** Login and billing recovery copy remain available. Catalog-write freeze was not independently proven in the remaining spec (service-name field was not a stable labeled control); API `SUBSCRIPTION_PAST_DUE` coverage is the existing command-bus suite.
- **Marketing cancel:** `/signup/cancel` says “Checkout canceled” / “No shop was created” and returns to pricing. Success-session invalid/confirmed paths remain in `platform-marketing-api.spec.ts`. Live Stripe Checkout was not duplicated.
- **Console/network:** Remaining-QA KNOWN-2 capture found no unexplained 4xx. Double-submit 201s are QA-007. Expected 403s remain in the front-desk billing deep-link test.

