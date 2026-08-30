# Implementation plan — launch defects only

Date: 2026-08-30  
Do not start this work until the audit is accepted. This is the ordered fix list, not a redesign.

Principle: **Stripe remains the only writer of subscription/money truth.** Local commands may *record* a Stripe result; they must not *invent* a paid state.

---

## Top 10 fixes (exact order)

### 1. Neutralize fake paid commands (P0-1, P0-2)

**Goal:** `billing.changePlan` and `billing.buyAddon` cannot grant entitlements or unfreeze a shop without Stripe.

**Do:**

- In `apps/api/src/handlers/billing.ts`, stop writing `subscription_status='active'`, `plan`, ledger credits, and `billing_invoices status=paid` with fabricated Stripe URLs.
- Until a Stripe-backed replacement exists, both handlers should throw `UPSTREAM_UNAVAILABLE` or `VALIDATION_FAILED` with a message that the owner must use Checkout/Portal.
- Alternatively: delete the command registrations **and** remove `POST /v1/desk/billing/change-plan` and `/buy-addon` if they only wrap those handlers.
- Do **not** keep a “local preview” that still flips `subscription_status`.

**Files:** `apps/api/src/handlers/billing.ts`, `apps/api/src/routes/billing.ts`, `packages/contracts/src/commands/billing.ts`, `apps/api/src/billing.test.ts`.

**Done when:** `dispatch('billing.changePlan', { targetPlan: 'growth' })` does not change `billing_accounts` or insert invoices; same for `buyAddon`. Freeze still lifts only via `billing.syncSubscription` from a signed webhook.

---

### 2. Stop the Settings UI from reporting a successful plan change (P1-1, P1-2)

**Goal:** No toast that says the plan changed unless Stripe changed.

**Do:**

- Remove or disable the Starter / Growth / Enterprise switch cards and the “Upgrade to Enterprise” button **until step 5**.
- Remove hardcoded invoice rows and the Download PDF toast.
- Remove hardcoded `stGrowthActive` / `$169` / sidebar `'Growth'` badge.

**Files:** `apps/web/src/pages/Settings.tsx`, `apps/web/src/i18n/settings.ts`.

**Done when:** Billing tab cannot call `billing.changePlan`. No fake `INV-2026-*` rows.

---

### 3. Render real billing state (P1-1 — journey last step)

**Goal:** Settings → billing shows what `GET /v1/desk/billing` and `GET /v1/desk/billing/invoices` return.

**Do:**

- Bind header to `billing.plan`, `subscriptionStatus`, `trialing`, `trialEndsAt`, `currentPeriodEnd`, `paymentMethodLabel`.
- Map **only** `essential` / `growth` (plus trial/past_due/canceled).
- Use `useInvoicesQuery`; hide download if `receiptPdfUrl` is null; never toast success for a no-op.
- Quota bars already read `quotas`; keep them.

**Files:** `apps/web/src/pages/Settings.tsx`, `apps/web/src/features/billing/api.ts`, `apps/web/src/features/billing/types.ts`, `apps/api/src/queries/billing.ts`.

**Done when:** An Essential trialing shop shows Essential + trial end, not “Growth active”. A past-due shop shows past due.

---

### 4. Close portal holes (P2-2, P2-9)

**Goal:** Manage-card is the interim real money UI.

**Do:**

- Reuse `safeReturnUrls` (or the same relative-path rule) for `POST /v1/billing/portal-session` `returnUrl`. Default to `/settings?tab=billing` on `APP_BASE_URL` (`desk.geniefront.com`, not `.app`).
- Frontend: if `!res.url` → danger toast, no success.
- Frontend: `returnUrl` should be a path, not `window.location.href`, unless the API strips origin.

**Files:** `apps/api/src/stripe/routes.ts`, `apps/web/src/features/billing/api.ts`, `Settings.tsx`.

**Done when:** Portal `return_url` cannot be `https://evil.example`. Missing URL does not claim success.

---

### 5. One real plan-change path (P1-2, P1-3)

**Goal:** Changing plan either goes to Stripe Checkout / Portal or is not offered.

**Pick one (recommended: Portal for change, Checkout only for first subscribe):**

- **A (smaller):** Hide in-app plan cards. Copy: “Change plan and card in Stripe billing portal.” Button = existing portal mutation (step 4).
- **B:** Wire `POST /v1/billing/checkout` with `plan: 'essential' | 'growth'` and return URLs `/settings?tab=billing`. Align UI names/prices with `docs/11` ($99 / $199). Delete Starter/Enterprise.

Do not reimplement `billing.changePlan` as a local writer. If you later wrap Stripe subscription-update, the handler must call Stripe **outside** the DB transaction, then `billing.syncSubscription`.

**Files:** `Settings.tsx`, `features/billing/api.ts`, `stripe/routes.ts`, `packages/contracts/src/commands/billing.ts` (narrow `targetPlan` to `essential | growth` or remove the command).

**Done when:** UI plan vocabulary = Stripe = DB check constraint. No `starter`/`enterprise` in the write path.

---

### 6. Wire card + AI topup to existing routes (P1-3)

**Goal:** Owners can bind a card and buy $50 credit or voice minutes without curl.

**Do:**

- Buttons → `POST /v1/billing/payment-method` and `POST /v1/billing/topup` `{ unit }`.
- Redirect to hosted Checkout / wait for webhook; refresh `useDeskBillingQuery`.
- Optional: `billing.setAutoTopup` controls (defaults stay off).
- Do not use `billing.buyAddon`.

**Files:** `Settings.tsx` or a small billing panel, `features/billing/api.ts` (add checkout/topup/payment-method helpers; they do not exist today).

**Done when:** Clicking topup creates a PI (or pending 3DS) and ledger balance moves only after `payment_intent.succeeded` / `recordTopup`.

---

### 7. Fix Queue complete-service trap (P1-4)

**Goal:** Notes and “mark room cleaning” do not abort finish.

**Do:**

- In `handleConfirmCompleteService` (`apps/web/src/pages/Queue.tsx` ~1216), keep the `!item.rawTicket` guard only.
- Persist notes via existing `ticket.addNote` (or equivalent) before `ticket.finishItem`.
- Persist room cleaning via the rooms command already used elsewhere (`Rooms.tsx`).
- If those writes are out of scope for this patch, **hide the fields** rather than leave a tripwire.

**Done when:** Finish with a note and/or cleaning flag succeeds or the fields are gone.

---

### 8. Align Checkout / trial email return URLs (P2-4 adjacent)

**Goal:** After Stripe or trial mail, owner lands on billing.

**Do:**

- `safeReturnUrls` defaults: `/settings?tab=billing` not `/?billing=done`.
- `sendTrialEndingOnce` `billingUrl` same.
- Optional: `tenantFromEvent` also read `event.data.object.subscription` / parent metadata for `invoice.*` so `invoice.payment_failed` logs attach to a shop.

**Files:** `apps/api/src/stripe/routes.ts`.

**Done when:** Hosted Checkout success opens Settings billing. Invoice events with empty invoice metadata still resolve tenant when the subscription carries `gf_location_id`.

---

### 9. Queue inline gift-card pay (P2-5)

**Goal:** Gift card from the queue modal either works or is not offered.

**Do:** Pass `giftCardCode` / `giftCardId` on the `ticket.pay` line (mirror `features/checkout/api.ts`), or remove the gift-card method from the queue modal and send them to `/checkout`.

**Files:** `apps/web/src/pages/Queue.tsx`.

**Done when:** Queue gift-card confirm does not 400 `VALIDATION_FAILED` for missing code.

---

### 10. Honesty pass for non-Stripe “submit” actions (P2-3, P2-6, P2-7)

**Goal:** Success toasts match persistence.

- 10DLC: copy = “saved, pending platform review” (or hide until TCR exists). `settings.apply10dlc` stays a local row.
- Messages refresh: no “stream synced” toast; quiet refetch or “refreshed”.
- Profile “enable recommended”: either call save immediately or toast “click Save to apply”.

**Files:** `Settings.tsx`, `Messages.tsx`, `Profile.tsx`, i18n.

---

## Mapping to launch

| Step | Before marketing? |
|---|---|
| 1 Neutralize fake commands | **Yes — blocker** |
| 2 Remove fake switch-plan / invoices | **Yes — blocker** |
| 3 Render real billing | **Yes — blocker** |
| 4 Portal URL safety | Yes (same billing pass) |
| 5 Real plan change or Portal-only | **Yes** if marketing shows three plans; else Portal-only + no cards |
| 6 Topup / bind card UI | If pricing promises AI packs; else immediately after launch |
| 7 Queue finish trap | After launch OK if trained; do in first desk hotfix |
| 8 Return URLs / invoice tenant | After launch OK |
| 9 Queue gift card | After launch OK |
| 10 Copy honesty | After launch OK |

---

## Out of scope for this plan

- Building `apps/ios` or `apps/platform`.
- Charging guests at the chair (POS stays record-only).
- Real 10DLC / TCR filing.
- Replacing command-bus freeze with a different entitlement system.
- Enum “Enterprise” as a third Stripe product (only if you create a Price and a `billing_plan` check together).

---

## Suggested verification after each step

1. API test: past_due shop cannot unfreeze via `billing.changePlan`; `buyAddon` does not increment `credit_ledger`.
2. Web: billing tab has no Starter/Enterprise confirm path.
3. Seed/trial shop: UI plan text matches `billing_accounts.plan` and Stripe.
4. Portal session `return_url` host is `APP_BASE_URL`.
5. Manual Checkout/Portal click updates `subscription_status` only after webhook.
6. Topup: Stripe dashboard PI + local ledger seq agree; retry does not double (PI id idempotency).
7. Queue: finish with note succeeds (or field removed).
8. Checkout success URL shows billing tab.
9. Queue gift card: either pays or is hidden.
10. 10DLC toast does not say a carrier received the filing.
