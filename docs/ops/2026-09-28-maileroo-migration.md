# Maileroo Migration

Date: 2026-09-28. Scope: GenieFront application outbound email, Supabase Auth SMTP, sending domains, and delivery callbacks.

## Receiving Mail

Fastmail remains the company mailbox provider. The user explicitly excluded receiving-mail migration. Neither MX records nor Fastmail routing were changed. No Maileroo inbound routes were created.

The four existing MX records on `geniefront.com` and `tenant.geniefront.com` were compared with the pre-migration Cloudflare snapshot and match exactly. Existing Fastmail SPF authorization, DKIM selectors, and DMARC policies remain intact.

## Sending

- Production API replicas (`gf-a`, `gf-b`) and staging use `EMAIL_PROVIDER=maileroo`.
- Local `.env` and `.env.local` use Maileroo while retaining their delivery/capture settings.
- Platform mail: `noreply@notify.geniefront.com`.
- Appointment mail: `noreply@appointment.geniefront.com`.
- Both Supabase projects use `smtp.maileroo.com:587` with STARTTLS and `noreply@geniefront.com`. A follow-up verification found staging still used the unverified legacy sender `noreply@mail.geniefront.com`; it was corrected to the verified root-domain sender. The earlier SMTP transport test used the root sender and did not detect this staging configuration gap.
- Verified Maileroo domains: `geniefront.com`, `notify.geniefront.com`, `appointment.geniefront.com`, `mkt.geniefront.com`, `tenant.geniefront.com`.
- Open/click tracking is disabled at the domain level and explicitly disabled on application messages, preserving booking and authentication links.
- Each environment has its own Maileroo application sending/SMTP credentials. SMTP secrets are excluded from runtime deployment. Account API access supports domain management; secrets remain in ignored env files.

## Delivery Tracking

`POST /v1/webhooks/maileroo` authenticates the original request bytes using the Maileroo HMAC-SHA256 signature. Both map tags and the actual name/value-array callback format are accepted.

An outbox reference is persisted before sending, so a callback arriving before the send response can still locate its row. Tenant identity, message reference, and recipient must all match. Delivery state advances monotonically. Hard invalid-recipient bounces and complaints suppress further delivery; a full mailbox or unknown failure does not cause permanent suppression. Ambiguous network failures stay `uncertain` and are not blindly retried.

Existing Resend/SES/Elastic callbacks remain available for historical messages. Elastic reconciliation is limited to previously sent Elastic messages; new sends and domain operations use Maileroo. Existing suppression/opt-out tables remain in place. The production suppression tables and Elastic suppression API contained zero records at migration time.

Marketing was already disabled and remains disabled. No new Elastic subaccounts or MailSlurp test inboxes are provisioned under the Maileroo provider. Maileroo's sending API is not treated as a mailbox-validation API: unsupported validation returns `unknown` with `verification_not_supported`, instead of calling Elastic or incorrectly labelling recipients invalid.

## Verification

- 9 isolated Maileroo unit tests passed.
- 5 Maileroo integration tests passed against a dedicated disposable PostgreSQL database, including real RLS, signed public routes, mismatched tenants/recipients, out-of-order callbacks, early callbacks, and ambiguous timeouts.
- 70 existing email tests passed: suppression (35), marketing-domain management (8), sender selection (11), Elastic compatibility (16).
- API and DB TypeScript checks, repository guards, shell syntax checks, and diff whitespace checks passed.
- Both application API credentials delivered controlled test messages to `maileroo@geniefront.com`; Maileroo logs reported `delivered`.
- Both SMTP credentials authenticated over STARTTLS and delivered controlled messages to that same Fastmail mailbox.
- Both Supabase Auth configurations were read back and matched the intended SMTP host, port, username, and sender address.
- A live staging test exercised application sending, Maileroo delivery, Fastmail receiving, the real signed webhook, and tenant outbox state `delivered`.
- Signed callback probes return 200; missing signatures return 401.

The first live callback test exposed Maileroo's array tag format. Parsing was fixed and the full flow was rerun successfully. No customer booking or customer record was created by the smoke test; its explicitly labelled staging outbox rows are retained as evidence.

The original rejected callback was subsequently retried by Maileroo and also reached `delivered`, verifying provider retry recovery. The disposable integration-test database container was stopped and removed after validation.

Final running images, all healthy:

- `gf-a`, `gf-b`: `geniefront/api:maileroo-production-1790635820741`.
- `gf-staging`: `geniefront/api:maileroo-staging-1790635817942`.

## Operations And Rollback

`scripts/maileroo-setup.mjs` provides explicit domain, DNS, credentials, webhook, Auth, status, and local-env operations. It has no MX or inbound-routing mutation mode.

`scripts/maileroo-release.mjs` builds API-only images from each environment's deployed Git base plus the specific email source files. This preserves production's existing voice fixes and excludes unrelated dirty working-tree changes. It updates only email runtime variables and the API container; frontend assets, Caddy, unrelated environment settings, and databases are preserved.

Release state is kept in ignored `.env.maileroo-release-production` and `.env.maileroo-release-staging` files. Runtime env snapshots are retained on each server as `.env.before-maileroo-*`. Original pre-migration images:

- Production: `geniefront/api:18e8668-20260928170957`.
- Staging: `geniefront/api:fb433fe-20260923161240`.

For an intentional rollback, restore the corresponding pre-migration runtime env snapshot and original API image together. Auth's original SMTP values are retained locally in `.env.production.maileroo-auth-backup` and `.env.staging.maileroo-auth-backup`. The original Cloudflare records are retained in `.env.production.maileroo-dns-backup`. These files contain operational secrets and must never be committed or printed.

Legacy provider accounts/subscriptions were not cancelled or deleted. Their credentials and DNS records are retained for historical callbacks and rollback.

Controlled end-to-end smoke command:

```sh
node --env-file=.env.staging --import tsx scripts/maileroo-smoke.ts <controlled-recipient>
```

Use a mailbox you control. This sends exactly one labelled message and does not flush any other queued mail.

Official protocol references: [Maileroo Email API](https://maileroo.com/docs/api-reference/emails/send-email), [Maileroo Webhooks](https://maileroo.com/docs/api-reference/emails/webhooks), [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp).
