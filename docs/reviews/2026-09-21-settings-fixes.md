# Settings and ownership fixes — 2026-09-21

## Behavior

- Local images are re-encoded before upload. Storage errors reject the operation and preserve the previous image; embedded data URLs can no longer masquerade as upload success. Public `avatars` and `store_logos` buckets accept raster MIME types, with insert access restricted to the authenticated user's own folder. Uploads use immutable UUID paths.
- Contact email editing pauses automatic saves until blur. Invalid email is rejected locally and shown at the field; backend errors use translated messages.
- Service creation through the shared desk save hook (including industry presets) fills missing short names in six languages before creating the service. Existing manual values are retained. Failure leaves the unsaved form intact. Explicit and batch generation require catalog management permission and the catalog subscription gate; generic copilot access remains restricted. This setup feature does not debit copilot credits. Provider usage/cost is logged and generation is rate limited.
- Delivery history is accessed through the main navigation, rather than repeated under every settings tab.
- API CORS includes PUT; Ops voice configuration saving has a browser preflight regression test.
- Voice allowances have independent trial/monthly and extra-allowance panels. Trial text explains that 20 minutes is shared across the trial; the quota calculation and balances are unchanged.
- Ops super administrators can transfer a single-store organization to an existing, verified account. The flow explicitly acknowledges retained payment details. It updates the organization owner and memberships, revokes the previous owner's store access and staff sessions, preserves historical attribution, and syncs the Stripe customer email without replacing subscriptions/cards. Notification recipients remain separately configured.
- Transfers use durable pending state and stable Stripe idempotency. Provider failure does not grant the new owner access. Retrying the same intent after a reload resumes it; completed retries do not duplicate grants or audit records.
- The new owner sees a payment-method review notice and must personally acknowledge it. Multi-store organizations, multiple current owners and shared Stripe customers are refused with specific instructions, rather than affecting unrelated stores.

## Rollout

Apply `20260921171225_settings_media_owner_transfer.sql` before deploying the API and desk/Ops bundles. The mirrored migration lives under `packages/db/sql` and `supabase/migrations`. No production database changes, ownership transfers or deployments were performed during this implementation.

## Verification

- Desk regression suites: image upload, service creation/catalog, autosave, billing layout and settings navigation.
- Ops component suites: voice configuration and owner-transfer acknowledgement.
- API suites: platform operations/CORS, short-name generation/permissions, catalog persistence and ownership transfer/retry/access revocation.
- Isolated PostgreSQL migration/RLS tests: bucket provisioning, owned paths, rejected cross-user/SVG inserts, privileged transfer isolation, repeatable migration.
- Contracts suite, TypeScript checks for API/desk/Ops, desk/Ops production builds and repository guard checks.

The database tests used a fresh local PostgreSQL container; no production credentials or live Stripe calls were used in tests.
