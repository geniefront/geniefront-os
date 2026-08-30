# Launch blockers

Date: 2026-08-30  
Companion: `FUNCTIONAL_AUDIT.md`, `IMPLEMENTATION_PLAN.md`.

A **blocker** here is a verified issue that should be fixed **before marketing traffic is pointed at this product** (pricing page → Stripe → activation → desk). Non-blockers can wait until after first shops are live, unless they are P0.

---

## Before marketing migration

Do these first. Order is in `IMPLEMENTATION_PLAN.md`.

### P0 — do not launch with these live

| ID | Why it blocks launch | Evidence |
|---|---|---|
| **P0-1** `billing.changePlan` | Any member with `billing.manage` can `POST /v1/commands/billing.changePlan` with `targetPlan: "growth"` (or `essential`) and the shop becomes `subscription_status='active'` **without Stripe**. That unfreezes a past-due tenant and changes included AI quotas. Handler also inserts a **paid** invoice with a fake `billing.stripe.com` receipt URL. Allowed during freeze because the name starts with `billing.`. | `apps/api/src/handlers/billing.ts` `registerHandler(BillingChangePlan)`; `apps/api/src/bus.ts` `WRITE_ALLOWED_WHILE_PAST_DUE`; `packages/db/sql/0021` allows `essential`/`growth`. |
| **P0-2** `billing.buyAddon` | Same permission can grant 100–1000 AI units, write `credit_ledger` topup, and a paid fake invoice, with **no PaymentIntent**. Also freeze-allowed. UI does not expose it; the command endpoint does. | `registerHandler(BillingBuyAddon)`; `features/billing/api.ts` `useBuyAddonMutation` unused in pages. |

Until these two commands either call Stripe or refuse to mutate entitlements, a knowledgeable owner (or a stolen owner session) can mint paid state.

### P1 — marketing / first-open will lie or bounce

| ID | Why it blocks marketing | Evidence |
|---|---|---|
| **P1-1** Settings billing is a demo | Last step of the purchase journey is “billing status visible in settings”. The tab always says Growth is active, shows $169, and lists three fake invoices. Real `GET /v1/desk/billing` data is only used for quota bars. A new Essential trial will look like a paid Growth shop. That is a support and chargeback incident waiting on day 1. | `apps/web/src/pages/Settings.tsx` ~2397–2608 |
| **P1-2** Switch-plan UI vs Stripe vs DB | Cards are Starter / Growth / Enterprise. Stripe and DB are Essential / Growth. Confirm sends `starter`/`enterprise`, which **fail** `billing_plan`. Growth is hardcoded `active` so they cannot switch to real Growth. Copy prices $89/$169/$299 ≠ $99/$199. | `Settings.tsx` confirm ~2928; `packages/contracts/src/commands/billing.ts` `BillingChangePlan`; `sql/0021` |
| **P1-3** No in-app Stripe money UI | Hosted Checkout, setup-mode card, $50 topup, auto-topup all exist in `stripe/routes.ts` and have **no** web callers. After signup, the only real button is Customer Portal (if `stripe_customer_id` exists). Owners cannot buy AI packs or bind a card inside the product except via Portal. Marketing can still sell the first subscription. | grep: `/v1/billing/checkout` only in `apps/api` |

**P1-4** (Queue finish-service notes trap) is a **daily ops** P1, not a marketing-funnel blocker. Fix soon; it can wait until after the first signup if desk staff leave notes empty. See “after launch”.

### External switches that must be true (NV, but launch-gating)

These are not code defects. If they are wrong, **nobody completes purchase**. Confirm in ops before flipping marketing:

1. Marketing Checkout metadata = `docs/11` (`gf_signup=1`, matching emails, `gf_plan` essential\|growth). **Do not** let the marketing site also consume the Stripe webhook.
2. Stripe webhook URL + `STRIPE_WEBHOOK_SECRET` on the API.
3. `STRIPE_PRICE_ESSENTIAL` / `STRIPE_PRICE_GROWTH` match Stripe products.
4. `APP_BASE_URL` in Supabase Auth redirect allowlist (`/activate`, `/reset-password`).
5. Magic Link email template is the only “welcome” mail (second mail invalidates the first).
6. `sql/0021` has been applied in prod (if not, P1-2 becomes another P0).

---

## Can wait until after launch

### P1 that is desk-only

| ID | Why it can wait | Residual risk |
|---|---|---|
| **P1-4** Queue complete-service | Happy path (no notes, no “mark cleaning”) finishes the ticket. First shops can be trained to use empty notes or finish from the ticket/tech screen. | Front desk that fills the note field thinks “complete” is broken. |

### P2

| ID | Why it can wait |
|---|---|
| P2-1 Fake invoice PDF toast | Misleading; not a charge. |
| P2-2 Portal success toast without URL | Rare; error path still toasts danger on throw. |
| P2-3 10DLC “submitted” is local-only | SMS is explicitly post-10DLC (`docs/01`). Hide or relabel. |
| P2-4 Invoice webhook tenant mapping | Freeze still comes from `customer.subscription.updated`. |
| P2-5 Queue gift-card inline pay | Desk `/checkout` path works. |
| P2-6 Messages “stream synced” | Cosmetic. |
| P2-7 Profile recommended prefs local until Save | Extra click. |
| P2-8 Analytics generate bypasses command bus | Cache table, not money. |
| P2-9 Portal `returnUrl` unsanitized | Needs a tight allowlist; not the purchase funnel. |

### P3

Growth nav badge, `/community` placeholder, copy-hours local toast, `.app` vs `.com` portal default.

---

## Do not treat as blockers

- **In-store POS is record-only.** Cash/card on tickets never hits Stripe. That is the product decision, not a gap.
- **`apps/ios` / operator console missing.** Nothing in the purchase or desk path imports them.
- **Storefront builder** is a brief work order, not a live editor (`docs/13`/`17`).
- **Auto-topup default off** — backend is real; no UI is a P1-3 commercial gap for AI packs, not a signup blocker.

---

## Launch go / no-go

**No-go for marketing migration until P0-1, P0-2, P1-1, and P1-2 are fixed.**  
P1-3 should be fixed in the same billing pass if the pricing page promises in-app plan changes or AI topups; if marketing only sells the first subscription and Portal handles cards, P1-3 can slip **one** sprint — but then **remove** Switch Plan / Enterprise / fake invoices so the UI does not promise them.

**Go** for a closed beta with seed shops if: P0 commands are disabled, Settings billing renders `loadBilling` truthfully (even if read-only + Portal), and the NV ops checklist above is green.
