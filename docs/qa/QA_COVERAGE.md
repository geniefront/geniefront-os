# Seed V2 Browser QA Coverage

Date: 2026-08-30  
Disposition: remaining exploratory browser QA completed; QA-007 and QA-008 repaired in the final fix pass. Open counted findings: none.

## What was added

- Playwright configuration for Chromium with one isolated worker and local QA web servers for `apps/api`, `apps/web`, `apps/platform`, and `apps/marketing`.
- A hard safety gate requiring `GF_QA_ALLOW_RESET=1`, `DATABASE_TEST_TARGET=isolated`, local-only database/Supabase/API origins, and `NODE_ENV=test` for reset/seed operations.
- Automatic capture of screenshots, traces, videos on failure, console errors, uncaught page exceptions, failed requests, and HTTP 4xx/5xx responses. Traces are configured for every completed test.
- Seed-aware fixtures and authored browser tests across auth/setup, billing/permissions, operations, platform/marketing/API, multi-location, responsive, and remaining-matrix specs.
- A narrow `growth_setup` Seed V2 scenario plus active platform-operator fixture support for platform review scenarios.
- Root scripts `test:e2e` and `test:e2e:ui`.

QA-001…QA-008 are FIXED / VERIFIED. Remaining-matrix coverage is in `e2e/specs/remaining-browser-qa.spec.ts`.

## Coverage status

| Area | Status | Evidence / result |
| --- | --- | --- |
| Login, protected deep links, reload | Completed | Owner and role fixtures authenticated; deep-link/reload behavior was exercised. |
| Logout | Completed | UI and session cleared. Local GoTrue logout occasionally ended as `net::ERR_ABORTED`; no stale authenticated UI remained. |
| Essential setup wizard | Completed | Profile/hours, services, staff, readiness/launch, and reload path passed in the earlier focused run. |
| Growth SetupWizard (KNOWN-3) | Completed | Full wizard: Save and continue → catalog → staff → launch → dashboard reload → Growth billing. Playwright Growth setup wizard test. |
| Schedule → queue → rotation → ticket → service → checkout → tips | Completed interactively | A browser-created Lisa Park visit moved through check-in, station assignment, service completion, 15% card tip, $51.75 settlement, and ticket display. |
| Deterministic automated operations chain | Completed (focused) | Seeded in-service visit is completable (QA-002 FIXED). Gift-card issue → list → verify → ticket.pay verified on Emily Stone. |
| Day close | Completed | Counted day finalized, showed closed/locked, and remained closed after reload. Evidence: `artifacts/playwright/evidence/day-close-finalized.png`. |
| Gift card full checkout | Completed | Issue POST 201, list GET returns the card, dialog closes, code verifies, `ticket.pay` 201 (QA-005 FIXED). Gift cards cannot pay tips; treated as intentional; regression uses No Tip. |
| Gift card queue-inline entry | Completed | Same path as gift-card checkout above, from the operations board settle modal. |
| Essential trial billing | Completed | Essential/trial quotas `0 / 20` voice and `0 / 150` credits; no payment method. |
| Growth active billing | Completed | Active plan, `Visa ···· 4242`, paid quotas `0 / 500` and `0 / 1200`. |
| Past-due billing | Completed | Past-due copy and Manage subscription. Catalog-write freeze not independently proven in the remaining UI spec; API bus coverage remains. |
| Add payment method | Completed | Essential trial mocked Stripe setup handoff. |
| Manual $50 credit top-up | Completed (mocked Stripe) | Growth **Buy $50 AI credits** posted `{ unit: 'credit' }` and showed “Payment confirmed.” Live Stripe charge not repeated (commercial E2E already passed). |
| Voice top-up | Completed (mocked Stripe) | **Buy $50 voice minutes** is exposed; posted `{ unit: 'voice_minute' }`. |
| Auto-top-up enable/disable + threshold | Completed | Credit auto-topup enable persists across reload and can be disabled. Threshold 50/20 is displayed; no editor. Treated as intentional enable/disable-only UI. |
| Owner / front desk / technician permissions | Completed | Front-desk `/settings?tab=billing` is rejected before owner-only queries (QA-003 FIXED). |
| Multi-location switching and isolation | Completed | Store A data absent in Store B; back/forward and reload retained Store B. West **Today** click is QA-008, not a tenant leak. |
| 10DLC customer submission | Completed | `growth_active` form submit → pending internal review after reload. Evidence: `artifacts/playwright/evidence/10dlc-customer-submitted.png`. |
| 10DLC platform internal review | Completed | `ten_dlc_pending` desk pending copy through platform Mark under review. Same-row submit→review is not possible in one Seed V2 scenario (seed wipes other V2 tenants). |
| Support request → platform handling | Completed (QA-007 FIXED) | Desk `/support` submits `support.submitRequest`; platform notes and resolves (QA-006). Rapid double-click issues one POST (QA-007). Error-path form retains values after a mocked 500. |
| Platform: owner denied | Completed | Desk owner could not enter platform. |
| Platform: revoked operator denied | Completed | Revoked fixture remained denied. |
| Platform: active operator allowed | Completed | Active operator signed in and remained authorized after reload. |
| Marketing Essential/Growth signup UI | Completed | `$99` / `$199` CTAs; mocked checkout handoff for both plans. |
| Marketing success-session | Completed | Missing session → invalid / “No payment has been verified”; mocked confirmed session → “Checkout completed”. |
| Marketing cancel path | Completed | `/signup/cancel` → “Checkout canceled” / “No shop was created” → back to pricing. |
| API browser-context health/auth | Completed | Direct API browser-context check passed. |
| Desktop layout | Completed | 1280×720 Chromium on queue, day-close, billing, schedule. |
| Tablet and narrow layouts | Completed | 820×1180 and 390×844 on queue and day-close plus billing/schedule. No document overflow in those specs. |
| Back/forward behavior | Completed | Queue ↔ schedule history plus multi-location isolation survived history navigation. |
| Double-submit, modal stale state, swallowed errors | Completed enough to count | Support double-submit is QA-007. Gift-card dialog close was QA-005 (fixed). 10DLC confirm is single-click covered. Not every desk form was double-clicked. |
| Timezone/date and cents/dollars | Completed (QA-008 FIXED) | Rotation/Schedule/Day Close Today and Yesterday use shop IANA via `instantToWallDate`/`shiftDate`. ScheduleContext no longer falls back to UTC ISO. Playwright NY evening and West shop clock cases. |

## Browser evidence collected

- Setup save/advance (fixed): `artifacts/playwright/evidence/qa-001-save-and-continue-advances.png`
- Seeded in-service complete (fixed): `artifacts/playwright/evidence/qa-002-seeded-in-service-completed.png`
- Front-desk settings deep-link (fixed): `artifacts/playwright/evidence/qa-003-frontdesk-settings-deep-link.png`
- Growth billing card on file (fixed): `artifacts/playwright/evidence/qa-004-growth-billing-card-on-file.png`
- Growth setup readiness: `artifacts/playwright/evidence/known-3-setup-ready.png`
- Multi-location Store B isolation: `artifacts/playwright/evidence/multi-location-west-isolated.png`
- Day-close persistence: `artifacts/playwright/evidence/day-close-finalized.png`
- Gift-card issue + checkout (fixed): `artifacts/playwright/evidence/operations-gift-card-checkout-complete.png`
- Desk support submit (fixed): `artifacts/playwright/evidence/qa-006-desk-support-submitted.png`
- Billing credit + voice top-up: `artifacts/playwright/evidence/billing-credit-and-voice-topup.png`
- Auto-topup disable: `artifacts/playwright/evidence/billing-auto-topup-disabled.png`
- 10DLC customer submitted: `artifacts/playwright/evidence/10dlc-customer-submitted.png`
- Marketing cancel: `artifacts/playwright/evidence/marketing-signup-cancel.png`
- KNOWN-2 after login: `artifacts/playwright/evidence/known-2-after-login.png`
- Timezone NY evening: `artifacts/playwright/evidence/timezone-ny-evening.json`
- Timezone West vs NY browser: `artifacts/playwright/evidence/timezone-west-shop-today.json`

The artifact directories are intentionally git-ignored; the reports preserve their workspace-relative locations.

## Verification ledger

| Requested verification | Status |
| --- | --- |
| Seed reset/seed | Completed repeatedly against the isolated local QA DB. Safety refusal logic is installed. |
| Existing regression tests | `@gf/db` 72 passed; `@gf/web` 153 passed; `@gf/marketing` 14 passed; `@gf/api` 741 passed (49 files). `@gf/platform` has no unit test files. |
| Typechecks | `@gf/api`, `@gf/web`, `@gf/db`, `@gf/platform`, `@gf/marketing` `tsc --noEmit` pass. |
| Playwright suite | **31 tests, 31 passed.** |
| Web/platform/marketing builds | `@gf/web`, `@gf/platform`, `@gf/marketing` production builds pass. |
| `git diff --check` | Pass. |
| `pnpm lint:guards` | Pass. |

## Current result summary

- **Playwright coverage:** 31 Chromium tests. 31 passed.
- **P0:** 0
- **P1:** 0 open (3 fixed)
- **P2:** 0 open (5 fixed)
- **P3:** 0
- **KNOWN-1:** Fixed (QA-004).
- **KNOWN-2:** Not reproduced as a desk API 404. Network capture after login found no unexpected 4xx. Most likely original resource-load 404 is missing `/favicon.ico` (not counted).
- **KNOWN-3:** Growth setup wizard E2E completed.
- **Multi-location isolation:** Passed. West **Today** now uses the shop timezone (QA-008 FIXED).
- **Console/network:** No unexplained 404 in the remaining capture. Support double-submit is one POST (QA-007 FIXED).

## Remaining untested / out of this batch

- Live Stripe Checkout / webhook commercial path (already PASS in `COMMERCIAL_E2E.md`; not duplicated).
- Same Seed V2 row for 10DLC submit **and** platform review (seed wipes other V2 tenants).
- Live DST spring-forward / fall-back in the browser clock (unit tests cover NY DST wall dates via `instantToWallDate` / `wallMinutesToInstant`).
- Double-submit on every desk form besides Support (10DLC confirm and gift-card issue were not double-clicked in the remaining pass).
- `past_due` catalog/appointment write freeze in the UI (API Seed V2 behavioral test covers `SUBSCRIPTION_PAST_DUE`).
- iPad/kiosk and `apps/ios` (deferred).
- Auto-topup **editable** threshold control (not exposed; treated as intentional).

---

# Coverage added by the independent final audit (2026-08-31)

## New regression suites

| File | Covers | Cases |
| --- | --- | ---: |
| `apps/api/src/systemOnly.test.ts` | AUD-01 — system-only command authorization | 8 |
| `apps/api/src/aiAdmission.test.ts` | AUD-03 — AI admission gate | 8 |
| `apps/api/src/auditFixes.test.ts` | AUD-04/05/06/09/11/13 | 17 |
| `e2e/specs/business-day.spec.ts` | AUD-13 — clock frozen inside the cutoff window | 3 |
| `apps/api/src/test/systemDispatch.ts` | shared seam separating tenant vs system invocation | — |

Existing suites updated so they no longer normalize the defect: `billing.test.ts`,
`blueprint.test.ts`, `phone.test.ts`, `giftcard.test.ts`, `signup.test.ts`,
`platform.test.ts`, `businessSummary.test.ts`, `financial_bi_subscription.test.ts`,
`qa/seed.behavior.test.ts`, `profile_and_notifications.test.ts`,
`stripe/webhook.tenant.test.ts`, `packages/db/src/rls.test.ts`,
`apps/web/src/pages/Support.test.tsx`.

## New executable guards (`pnpm lint:guards`)

| # | Rule | Verified to fire |
| --- | --- | --- |
| 9 | No business-table writes outside `handlers/` — the first executable check for 宪法第 1 条 | Yes: injected a raw `update appointments` and the build went red |
| 10 | Every model call has `assertAiAdmission` above it (`scripts/check-ai-gate.mjs`) | Yes: removed one gate and the build went red — and on first run it found a genuinely ungated streaming `askCopilot` |

Both guards were deliberately negative-tested. A guard that has never been observed
failing is not yet evidence of anything.

## Coverage status delta

| Area | Before | After |
| --- | --- | --- |
| Tenant reachability of internal commands | untested — the suite *performed* the exploit | whole-registry assertion; new unmarked internal commands fail the build |
| AI spend admission | untested (no such concept) | 8 cases + positional lint guard |
| Command-bus bypass | untested | lint guard + audit-row assertions |
| Cross-org customer FK | read isolation only | write rejection at app and DB layers |
| Notification permissions | untested | role-boundary cases for tech vs owner |
| Stripe PM projection | one-directional | both directions incl. detach, and blip-tolerance |
| Support notes confidentiality | none | RLS policy shape assertion + UI absence assertion |
| Idempotency retention | none | replay-inside-window and purge-outside-window |
| PIN hashing | none | salt uniqueness, non-legacy format, dual legacy migration |
| SMS inbound isolation | query discipline only | proven at RLS with two orgs |
| Desk "today" / "yesterday" | timezone only; both QA-008 clock cases sit **after** the cutoff, where either implementation passes | business day incl. cutoff, across NY before/at/after, LA before, DST spring & fall, plus 3 browser cases frozen **inside** the cutoff window |

## Verification ledger (2026-08-31 fix pass)

| Check | Result |
| --- | --- |
| `@gf/api` | **775 passed** (52 files) |
| `@gf/web` | **169 passed** (32 files) |
| `@gf/db` | **73 passed** (4 files) |
| `@gf/marketing` | **14 passed** (3 files) |
| `@gf/platform` | no unit test files (unchanged) |
| Typechecks api/web/db/platform/marketing | pass |
| Builds web/platform/marketing | pass |
| `pnpm lint:guards` | pass (10 rules) |
| `git diff --check` | pass for all audit-fix files |
| Playwright | **34 passed / 34** (31 prior + 3 new AUD-13 clock cases) |
| FORCE RLS | 106/106 tables enabled **and** forced; `app_user` has no BYPASSRLS |
| AUD-01 exploit replay | blocked at both layers; billing row unchanged; signed system path still works |

## Baseline honesty note

Before the fix pass the API suite was **38 failed / 741** on this machine, not the
741-green recorded on 2026-08-30. 35 of those were a clock-dependent seed defect
(fixed, see QA_FINDINGS "Fixed in passing") and 3 were caused by this pass's own
schema change (corrected). The two runs were compared file-by-file rather than by
totals, because a total that moves for two reasons at once explains nothing.


## AUD-13 addendum (2026-08-31)

`apps/web/src/lib/time.test.ts` grew to **26 cases**. The ones that matter are the ones
inside the cutoff window — the rest of the suite could not distinguish "shop timezone
calendar day" from "shop business day", because outside that window they are the same
string.

Two Playwright titles were corrected: they described the QA-008 *defect*
("uses UTC…", "follows the browser timezone…") rather than the behaviour they now guard.
A passing test whose name states the bug is worse than no name at all.
