# Current state — GenieFront OS

Date: 2026-08-30

## Launch / QA posture

- **Batches 1–7.5:** complete and accepted.
- **Real Stripe TEST commercial E2E:** PASS (`docs/qa/COMMERCIAL_E2E.md`). Path: marketing → Stripe TEST Checkout → signed webhook → provisioning → activation → claim → setup → desk → Billing.
- **Original audit issue counts:** zero remaining as open launch defects from Batches 1–7.5 (see `FUNCTIONAL_AUDIT.md` / `LAUNCH_BLOCKERS.md` for the historical record).
- **Seed V2:** introduced (`packages/db/src/qa`, `docs/qa/TEST_DATA_AUDIT.md`, `docs/qa/SEED_SCENARIOS.md`). Scenario-selectable QA reset/seed, production-refused.
- **apps/ios:** deferred.
- **Playwright / browser exploratory QA:** **NOT YET DONE.** Do not start until Seed V2 is accepted.

## Production migrations still required

These numbered files must be applied in production. Do not rewrite them.

| File | Topic |
|---|---|
| `packages/db/sql/0072_stripe_invoice_tenant.sql` | Stripe invoice tenant isolation |
| `packages/db/sql/0073_10dlc_internal_review.sql` | 10DLC customer submit = GenieFront internal review |
| `packages/db/sql/0074_platform_console.sql` | `platform_operators` + support requests + platform readers |

Local isolated and remote DEV already have these applied as of the commercial E2E run. Production still needs them if that environment has not been migrated.

## Canonical product facts (do not reopen)

- Plans: `essential` / `growth` only. Display prices: `PLAN_PRICES_CENTS` $99 / $199.
- Stripe is paid-state truth. `billing.syncSubscription` / `billing.recordTopup` record Stripe results. `billing.changePlan` and `billing.buyAddon` refuse local paid mutation.
- 10DLC `pending_review` = received by GenieFront, not carrier/TCR filed.
- Platform auth = `platform_operators` active row. Owner role never suffices.
- Support requests are a real tenant-scoped model (`open` / `in_progress` / `waiting` / `resolved` / `closed`).

## Seed V2 commands

```bash
pnpm qa:reset
pnpm qa:seed <scenario>
```

See `docs/qa/SEED_SCENARIOS.md`. Requires `GF_QA_ALLOW_RESET=1` and the isolated `TEST_*` database URLs.
