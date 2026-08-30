# Functional audit — GenieFront OS

Date: 2026-08-30  
Scope: `apps/web`, `apps/api`, `packages/contracts`, `packages/db`, Stripe billing, auth, setup, desk.  
Method: code-path tracing only. No production source was modified.  
Standard: **VERIFIED** = cited file/function path. **NEEDS VERIFICATION** = suspicious but not proven from this repo’s runtime.

This audit treats the earlier system map as given. It looks for broken or fake production flows, not architecture taste.

---

## Counts

| Class | Count |
|---|---|
| Verified P0 | 2 |
| Verified P1 | 4 |
| Verified P2 | 9 |
| Verified P3 | 4 |
| Needs verification | 7 |

P0 = tenant/billing integrity failure that can grant paid entitlements, unfreeze a past-due shop, or write fake “paid” invoices.  
P1 = a launch-critical commercial or daily path that is materially broken in the UI the user actually clicks.

---

## 1. Billing — every UI action

Settings billing lives in `apps/web/src/pages/Settings.tsx` tab `billing`. Supporting hooks: `apps/web/src/features/billing/api.ts`, `apps/web/src/features/settings/api.ts` (`useDeskBillingQuery`). Backend: `apps/api/src/stripe/routes.ts`, `apps/api/src/routes/billing.ts`, `apps/api/src/handlers/billing.ts`, `packages/contracts/src/commands/billing.ts`.

### 1.1 Action matrix

| UI control | Handler | Frontend call | Contract | API | Stripe | DB | Webhook | Refresh | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Quota meters (voice / copilot) | render only | `useDeskBillingQuery` → `GET /v1/desk/billing` | n/a | `registerBillingRoutes` + `loadBilling` | `maybeAutoTopup` as side effect | read `billing_accounts` / `credit_ledger` | n/a | query | **WORKING** (read). Display is real usage vs included totals. Surrounding chrome is fake (see 1.2). |
| “Manage card” / Stripe portal | `createPortalMutation.mutateAsync` | `POST /v1/billing/portal-session` | n/a | `registerStripeRoutes` portal session | `billingPortal.sessions.create` | reads `stripe_customer_id` | later `customer.subscription.*` | opens URL | **PARTIALLY WORKING**. Real Stripe call. Fails if no customer. `returnUrl` is **not** sanitized (unlike Checkout). If `url` is missing, UI still toasts success (`stStripeRedirect`). |
| “Upgrade to Enterprise” | `setConfirmChangePlan(stPlanEnterprise)` | confirm → `useChangePlanMutation` → `billing.changePlan` | `BillingChangePlan` `targetPlan: starter\|growth\|enterprise\|essential` | `registerHandler(BillingChangePlan)` | **none** | `update billing_accounts` + insert `billing_invoices` status=`paid` with fake `https://billing.stripe.com/receipt/...` | none | toast `stPlanChanged` | **DANGEROUS** API; **DEAD** UI for Enterprise/Starter because `billing_plan` check is `('essential','growth')` (`sql/0021`). Request 500s. |
| Plan card “Switch plan” (Starter / Enterprise) | same confirm dialog | same `billing.changePlan` | same | same | **none** | would write illegal `starter`/`enterprise` | none | success toast only if mutation resolves | **DEAD** in UI (constraint). **DANGEROUS** if called with `essential`/`growth` via `/v1/commands/billing.changePlan`. |
| Growth card | `disabled={plan.active}` with `active: true` **hardcoded** | none | n/a | n/a | n/a | n/a | n/a | n/a | **FAKE**. Always shown as current, independent of `billing.plan`. |
| Invoice “Download PDF” | `onClick={() => toast.success(stInvoiceDownloading)}` | none | n/a | `GET /v1/desk/billing/invoices` exists but unused | none | hardcoded `INV-2026-08/07/06` in JSX | none | fake toast | **FAKE/STUB** |
| Hosted Checkout subscribe | **no button** | no `POST /v1/billing/checkout` from web | n/a | route exists | `checkout.sessions.create` mode=subscription | via webhook `billing.syncSubscription` | `checkout.session.completed` | n/a | **DEAD** in this app. **WORKING** API for marketing-site signup. |
| Bind card (setup Checkout) | **no button** | no `POST /v1/billing/payment-method` | `billing.savePaymentMethod` | route exists | Checkout `mode: setup` | webhook → `SavePaymentMethod` | `checkout.session.completed` setup | n/a | **DEAD** UI. **WORKING** API. Portal can substitute if customer exists. |
| Manual $50 topup | **no button** | no `POST /v1/billing/topup` | `billing.recordTopup` | route exists | PaymentIntent $50 off-session | `credit_ledger` | `payment_intent.succeeded` | n/a | **DEAD** UI. **WORKING** API. |
| Auto-topup toggle | **no control** | `useSetAutoTopup` unused | `billing.setAutoTopup` | command bus | later `maybeAutoTopup` | account flags | PI webhooks | n/a | **DEAD** UI. **WORKING** backend. Defaults **off**. |
| Buy addon packs | **no control** | `useBuyAddonMutation` unused | `billing.buyAddon` | handler **does not call Stripe** | none | `credit_balance`/`voice_minute_balance` + ledger + fake paid invoice | none | n/a | **DANGEROUS** live API. **DEAD** UI. |
| Tax profile | **no control** | `useSaveTaxProfileMutation` unused | `billing.saveTaxProfile` | command | none | `billing_accounts.tax_profile` | n/a | n/a | **DEAD** UI. **WORKING** API (local JSON, not Stripe Tax). |
| Add second store billing | **no control** | no `POST /v1/billing/add-store` | `location.create` + `billing.syncSubscription` | route exists | `subscriptionItems.create` | new location + `location_subscriptions` | later subscription events | n/a | **DEAD** UI. **WORKING** API. |

### 1.2 Hardcoded billing chrome (same screen as real meters)

`Settings.tsx` ~2397–2608:

- Sidebar badge `'Growth'` is a string, not `billing.plan`.
- Header badge always `stGrowthActive` (“Growth plan · subscription active”).
- Price copy `$169` / `$89` / `$299` vs Stripe contract Essential **$99** / Growth **$199** (`docs/11`, `packages/payroll/src/credits.ts` `PLANS`, `stripe/client.ts` `priceIdFor`).
- Plan cards: Starter / Growth / Enterprise. Canonical plans are `essential` / `growth`.
- Invoice table is three literal rows, not `useInvoicesQuery`.

Quota bars **do** read `billing.quotas`. A past-due Essential shop still looks like an active Growth subscriber with $169 invoices.

### 1.3 `billing.changePlan` — fake paid, freeze bypass

Path:

```
Settings confirm
→ useChangePlanMutation
→ runCommand('billing.changePlan')
→ POST /v1/commands/billing.changePlan
→ registerHandler(BillingChangePlan) in handlers/billing.ts
```

Handler (no Stripe):

1. `ensureAccount`
2. `PLAN_PRICES` map including `starter`/`enterprise`
3. `update billing_accounts set plan=..., billing_cycle=..., subscription_status='active'`
4. Insert `billing_invoices` `status='paid'` and `receipt_pdf_url = https://billing.stripe.com/receipt/INV-...`
5. Return `{ success: true, effectiveImmediately: true }`

Consequences:

- Prefix `billing.` is in `WRITE_ALLOWED_WHILE_PAST_DUE` (`apps/api/src/bus.ts`). A past-due owner can call this and **unfreeze writes** without paying.
- `essential` / `growth` pass `sql/0021` `billing_plan` check. Those values grant `PLAN_QUOTAS` without Stripe.
- `starter` / `enterprise` (what the UI sends) violate the check → 500. UI does not currently complete a fake upgrade; the **API** still does for legal enum values.
- Fake Stripe receipt URLs.

Same handler is also mounted at `POST /v1/desk/billing/change-plan`.

**P0-1.**

### 1.4 `billing.buyAddon` — credits without charge

`registerHandler(BillingBuyAddon)`:

- Adds 100 / 500 / 1000 units to cache + `credit_ledger` kind=`topup`
- Inserts a **paid** invoice with a fake Stripe receipt URL
- No PaymentIntent, no Checkout
- Also `billing.*` → allowed while past due

Frontend hook exists; no page calls it. The generic command endpoint is live for anyone with `billing.manage`.

**P0-2.**

### 1.5 Hosted Stripe paths that *are* real

`apps/api/src/stripe/routes.ts`:

| Route | Behavior | Idempotency / identity |
|---|---|---|
| `POST /v1/billing/checkout` | Hosted subscription Checkout. Trial only if location never had sub id **or** `trial_ends_at`. Metadata `gf_location_id`/`gf_org_id`. `safeReturnUrls` (relative path only). | Owner `billing.manage` |
| `POST /v1/billing/payment-method` | Hosted setup Checkout, `currency: usd` | same |
| `POST /v1/billing/topup` | Off-session PI $50, metadata `gf_kind=topup` | records via `billing.recordTopup` keyed by PI id |
| `POST /v1/billing/add-store` | `location.create` **then** subscription item | Stripe idempotency `add-store-item-{locationId}` |
| `POST /v1/stripe/webhook` | Raw-body HMAC, then `claimStripeEvent` lease | Tenant from **our** metadata, not the browser |

Webhook `handleEvent`:

- setup session → `billing.savePaymentMethod`
- subscription created/updated/deleted → `billing.syncSubscription` (`planForPriceId` returns null on unknown price → **keep existing plan**, do not demote)
- `payment_intent.succeeded` only if `gf_kind` is `topup` \| `auto_topup`
- `customer.subscription.trial_will_end` → one email
- `invoice.payment_failed` → log only **if tenant resolved**

`tenantFromEvent` reads **only** `event.data.object.metadata`. Comment claims fallback to related objects; code does not. Typical `invoice.*` events have empty invoice metadata → `{ ignored: 'no_tenant_metadata' }`. Freeze still depends on `customer.subscription.updated` (subscription metadata is written by us). Observability gap, not a freeze hole.

**P2-4.**

Write-freeze (`bus.ts` `assertSubscriptionAllowsWrite`): `past_due` \| `canceled` \| `unpaid` \| `incomplete_expired` block non-`billing.` / non-`setup.` commands. Reads are not on the bus. **WORKING**, except the `billing.changePlan` bypass above.

### 1.6 Enum drift (verified)

| Layer | Values |
|---|---|
| Stripe / payroll / webhook / provision SQL | `essential`, `growth` |
| `billingPlan` zod (`SyncSubscription`) | `essential`, `growth` |
| `BillingChangePlan` zod | `starter`, `growth`, `enterprise`, `essential` |
| Frontend `ChangePlanInput` | `starter`, `growth`, `enterprise` (**no essential**) |
| DB check `billing_plan` (`sql/0021`) | `essential`, `growth` |
| Drizzle comment on `billing_accounts.plan` | still says `starter \| growth \| enterprise \| essential` |
| Settings UI | Starter $89 / Growth $169 / Enterprise $299 |
| `docs/11` | Essential $99 / Growth $199 |

**P1-2** (drives the broken switch-plan control).

---

## 2. Frontend / API contract — interactive controls

Not decorative. Only primary actions.

### VERIFIED defects

| ID | Page | What it claims | What it does | Sev |
|---|---|---|---|---|
| P1-1 | Settings → billing | Live subscription, invoices, upgrade | Hardcoded Growth / prices / invoices. Switch-plan does not talk to Stripe. | P1 |
| P1-2 | Settings → billing confirm | “Plan changed” | Sends `starter`/`enterprise`; DB check rejects. Growth card disabled by fake `active: true`. | P1 |
| P1-3 | Settings | Owner can subscribe, bind card, buy AI quota | `POST /v1/billing/checkout`, `/payment-method`, `/topup` have **zero** web callers. Auto-topup hook unused. | P1 |
| P1-4 | Queue complete-service | Notes + “mark room cleaning” are part of finish | `handleConfirmCompleteService`: if `technicianNotes.trim()` **or** `markRoomCleaning` **or** `!rawTicket` → toast fail and return. Filling the offered fields **blocks** finish. Happy path (empty notes, no cleaning) still works. | P1 |
| P2-1 | Settings invoices Download | PDF | Success toast only. | P2 |
| P2-2 | Settings portal | Redirect to Stripe | Toast success when `url` missing. | P2 |
| P2-3 | Settings 10DLC submit | Submitted for review | `settings.apply10dlc` inserts `location_10dlc_registrations` `pending_review`. No Telnyx/TCR call. Copy says submitted. | P2 |
| P2-5 | Queue inline checkout gift card | Pay with gift card | `closeTicketMutation` payment line has no `giftCardId`/`giftCardCode`. Contract refine requires one. Validation fails. Desk `/checkout` path is separate and does send codes. | P2 |
| P2-6 | Messages refresh | “Stream synced” | `refetch()` + success toast. No stream. | P2 |
| P2-7 | Profile “enable recommended” | Applies prefs | Sets `localNotifPrefs` + toast. Persist only on later Save (`saveNotifPrefsMutation`). Easy to think it saved. | P2 |
| P3-1 | Settings nav badge | Current plan | Literal `'Growth'`. | P3 |
| P3-2 | `/community` | Feature | `UnderConstruction`. | P3 |
| P3-3 | Hours “copy weekdays” | Saved | Local state + toast; real persist is Save Hours. | P3 |

### Working primary flows (spot-checked)

These call `runCommand` / real GET and await before success toasts:

- Setup wizard: store / catalog / team / `location.finishSetup` (`StepForms.tsx`, `handlers/setup.ts` readiness checks).
- Schedule create/reschedule/cancel (`features/schedule/api.ts`).
- Queue join / update / seat → `ticket.open` + `ticket.startItem` (`Queue.tsx` ~1164).
- Rotation clock-in/out, override, break (`features/rotation/api.ts`).
- Tickets open/add/start/finish (`features/tickets/api.ts`).
- Checkout `ticket.pay` (`features/checkout/api.ts`) with idempotency.
- Day-close save count / pay tips / finalize / reopen (`features/dayclose/api.ts`).
- Customers CRUD / block / merge / SMS command.
- Storefront brief submit / revision / launch request (work-order commands, not a site publisher).
- Hardware pairing PIN, wake, reset, revoke (`HardwareServer.tsx` awaits mutations).
- Login password, Google, password-reset via `/v1/auth/password/reset`.

Copilot: `/v1/ai/copilot` returns proposals only; execute is `runCommand` with the human’s membership (`copilot/routes.ts`). Billing commands are `ai.exposed: false`.

---

## 3. Auth / tenant isolation

### VERIFIED SAFE

| Control | Path |
|---|---|
| Bearer is Supabase JWT via JWKS; API cannot mint user tokens | `apps/api/src/auth.ts` `verifyAccessToken` |
| `X-Membership-Id` is not trusted: `loadMembershipBase` under `withUser`; RLS `identity_self` is `user_id = app_user_id()` | `packages/db/src/identity.ts`, `sql/0003` |
| Same membership id for another user → empty row → `PERMISSION_DENIED` `membership_not_owned` | `apps/api/src/actor.ts` `buildContext` |
| Grants = roles ∪ allow − deny; deny last | `actor.ts`, `staffContextFromToken` |
| Writes go through `dispatch` permission + audit + `withTenant` SET LOCAL | `apps/api/src/bus.ts` |
| Staff token: location/membership from `staff_sessions` hash lookup; header membership ignored when `X-Staff-Token` present | `server.ts` `ctxFromHeaders`, `auth/staffSession.ts` |
| Kiosk: `gfk_` hash → `withDeviceToken`; permissions only `queue.join` + `form.submit`; generic `/v1/commands` still requires Bearer or staff token | `kiosk/deviceAuth.ts`, `server.ts` PUBLIC list |
| Public shop: `X-GF-Public-Key` → `withPublicKey`; not a client `locationId`. `source: 'web'`, no `override`, prices from DB | `public/publicAuth.ts`, `public/routes.ts` ~393 |
| Stripe webhook: signature on raw body; tenant from object metadata we wrote; actor permissions `{ billing.manage }` only | `stripe/verify.ts`, `tenantFromEvent`, `systemContext` |
| Freeze on command bus before handler | `assertSubscriptionAllowsWrite` |

### VERIFIED defects

| ID | Issue | Sev |
|---|---|---|
| P0-1 | `billing.changePlan` allowed during freeze and sets `subscription_status='active'` | P0 |
| P0-2 | `billing.buyAddon` allowed during freeze and grants ledger credits | P0 |
| P2-8 | `POST /v1/desk/analytics/copilot-summary/generate` writes `ai_business_summaries` via `withTenant` **without** `dispatch` → no freeze, no audit command | P2 |
| P2-9 | `POST /v1/billing/portal-session` accepts arbitrary `returnUrl` (open redirect after Stripe). Checkout uses `safeReturnUrls`; portal does not. Default host `desk.geniefront.app` vs `desk.geniefront.com`. | P2 |

Kiosk/public/staff cannot pick another tenant id. No P0 isolation hole found outside the billing commands.

---

## 4. Commercial journey (purchase → desk → billing visible)

Intended path (`docs/11`, `docs/12`, code):

1. **Marketing Checkout** with `gf_signup=1` and required metadata. **This repo does not create that session.** Contract is `docs/11`. **NEEDS VERIFICATION** against the live marketing site.
2. `POST /v1/stripe/webhook` `checkout.session.completed` + `isSignupSession` (`gf_signup=1` and no `gf_location_id`).
3. Email mismatch (`customer_email` vs `gf_owner_email`) → reject, HTTP 200, no rows (`signup/webhook.ts` `emailsAgree`).
4. `gf_provision_tenant` (`packages/db/src/signup.ts`, `sql/0030`): org + location `status=setup` + `billing_accounts` + `signup_intents`. Idempotent on `checkout_session_id`. Unknown plan/timezone/type fall back and stash originals in metadata.
5. `backfillStripeMetadata` writes `gf_location_id` / `gf_org_id` onto customer + subscription. Failure is logged, webhook still 200.
6. After `handleEvent` syncs subscription: `sendActivationOnce` claims `activation_email_sent_at` then `signInWithOtp` (`signup/activation.ts`). Anon key. Failure clears the claim so Stripe retry can resend. Shop remains provisioned.
7. `/activate` (`Activate.tsx`): Magic Link session → set password; or password/Google. Then `claimStore()` → `POST /v1/setup/claim` (no membership header). Server `claimableIntentFor(userId)` compares **auth.users email** (canonical, `sql/0047`) to `signup_intents.owner_email`. Dispatch `setup.claimLocation`.
8. SessionGate: `locationStatus === 'setup'` mounts only SetupWizard (`App.tsx`).
9. Wizard: profile confirm, hours, ≥1 service, ≥1 bookable staff; `location.finishSetup` re-checks in SQL (`handlers/setup.ts`). `useFinishSetup` `reloadLocations` then navigate dashboard.
10. **Billing visible in Settings:** **FAILS.** Tab does not render `billing.plan` / `subscriptionStatus` / `trialEndsAt` / real invoices.

Assumptions that break the journey (several are NV):

| Assumption | If false | Class |
|---|---|---|
| Marketing sends `gf_signup=1` + matching emails + `gf_plan` in {essential,growth} | Money taken, no shop, or silent plan fallback | NV |
| `STRIPE_WEBHOOK_SECRET` / endpoint live | No provision, no activation mail | NV |
| Supabase Auth redirect allowlist includes `APP_BASE_URL/activate`; Magic Link template is the only welcome mail | Dead or competing links | NV |
| Gmail dots/googlemail canonicalized (`sql/0047`) | Paid, “no claimable store” | VERIFIED mitigation exists; remaining aliases NV |
| Webhook backfill of Stripe metadata succeeds | Later invoices “no tenant” | P2 if it fails; code logs |
| Settings billing shows Stripe truth | Owner cannot see trial/plan/card | **P1-1 VERIFIED** |

`locations.status` (`setup`→`active`) is independent of `billing_accounts.subscription_status`. Finish-setup is **not** `setup.*` or `billing.*`, so a shop that is `past_due` **before** finishing the wizard cannot `location.finishSetup`. Unlikely on first trial; possible if the card fails during setup. **P2** edge.

---

## 5. Daily desk workflow

```
Login → LocationPicker → Schedule/Queue → Rotation → ticket.open
  → start/finish items → Checkout ticket.pay → tips on payment lines
  → DayClose saveCount / payTips / finalize
```

### Connected

- Login: Supabase password + Google; reset via API (always `{ok:true}`).
- Select location: server list; stored id discarded if not in set; single shop auto-selects (`session.tsx`).
- Schedule: `appointment.create` / reschedule / cancel.
- Walk-in: `queue.join` source `desk`.
- Seat: `ticket.open` with items + `ticket.startItem` + `queue.update` seated (`Queue.tsx` ~1164–1198).
- Rotation: real commands.
- Checkout page: `ticket.pay` with idempotency, gift card verify, cash tender/change/keepChange.
- Tips: payment `tipCents` + optional `tipSplits`; payroll snapshot at close.
- Day-close: commands; open-ticket warning; force flag when unsettled.

### Disconnected / partial

| ID | Break | Sev |
|---|---|---|
| P1-4 | Complete-service modal notes / room-cleaning short-circuit | P1 |
| P2-5 | Queue **inline** gift-card pay missing code | P2 |
| — | Queue Apple Pay is recorded as `card` (record-only POS; acceptable) | not a defect |
| P3-2 | Community placeholder | P3 |

No evidence that schedule → ticket → checkout is a stub. The dangerous fake money is **SaaS billing**, not POS. POS remains record-only by design (`payments.processor_ref` is a note).

---

## 6. Needs verification (not counted as defects)

1. Live marketing Checkout metadata vs `docs/11` (site is outside this package).
2. Production `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ESSENTIAL`, `STRIPE_PRICE_GROWTH`.
3. Stripe Customer Portal products (in-app “manage card” depends on Stripe dashboard config).
4. Supabase redirect URLs + Magic Link template.
5. Production DB actually has `sql/0021` `billing_plan` (repo migrations do; a skipped migrate would make UI Starter/Enterprise **succeed** as P0).
6. Activation email deliverability / SMTP reputation.
7. Whether any owner already uses `/v1/commands/billing.changePlan` or `buyAddon` in the wild.

---

## 7. What is not in this audit

- `apps/ios` placeholder.
- Missing `apps/platform` operator console.
- Template folders outside `geniefront-os`.
- Telnyx account provisioning (code present; ops NV).
- Visual polish.
