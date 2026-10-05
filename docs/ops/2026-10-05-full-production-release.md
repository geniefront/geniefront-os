# Full production release — 2026-10-05

The user authorized committing the entire workspace and deploying it together.
All pending source, migrations, test evidence and documentation were committed
and pushed to `main`, with the seven existing remote commits merged rather than
overwritten. Existing production-only voice repairs were retained.

## Deployed

- Runtime/deployment source: `66e25e363d83c1c3cceb0afe90354d4eff0360ff`.
- Image: `geniefront/api:full-20261005T164000Z` on both gf-a and gf-b.
- API and dedicated `voice-snapshots` containers are healthy, with zero restarts.
- Web/desk, booking, kiosk, platform and marketing production builds were published.
- Production migration ledger advanced from 151 to 188 (37 incremental migrations).
- No seed/reset, synthetic production appointment, customer, payment or refund was submitted.

The full code release includes customer commerce and Traditional Chinese support.
Production customer-commerce activation and its dedicated Stripe webhook secrets
remain unset, matching the pre-release configuration. This release does not enable
live customer charging or change merchant payout/acceptance settings.

## Preservation and recovery

Before migration, the normal encrypted production backup completed, its remote
download decrypted/verified, and the restore check passed in an isolated container.
Existing application files, frontend assets, runtime configuration and image names
were saved on each host under:

`/opt/geniefront/releases/full-20261005T164000Z/`

Original-column row fingerprints matched after migration and release for the
checked business tables, including 31 appointments, 42 appointment items, 27
customers, the billing account and 105 phone calls. New commerce orders, payments
and paid memberships remained zero. New commerce tables passed the RLS/anonymous
access check. Detailed aggregate evidence is in the release JSON below.

Do not roll back SQL by deleting tables or financial history. For application
rollback, preserve the upgraded schema, restore the compatible prior application
configuration/assets/image and remove the standalone snapshot worker when returning
to the previous API's inline scheduler.

## Verification

- 16-package type checks and repository guards passed.
- 1,393 non-database tests and 127 database tests passed.
- The broad API run passed 1,829 of 1,830 tests; the remaining failure was a
  time-dependent deposit fixture that scheduled a web booking outside business hours.
  After fixing its local-time slots, the affected 66-test deposit/voice group passed,
  followed by the 21-test voice fixture and real process-isolation check.
- The isolated test runner now supplies synthetic encryption/auth settings and uses
  the exact disposable target required by the commerce clock fixtures. It never
  loads production credentials or resets an existing database.
- Remote voice regression tests and the six-language merge were included; the
  affected frontend language suites passed (18 tests).
- All five frontend production builds, API/worker image builds, Caddy header tests,
  and deployment shell checks passed. Deployed commit CI passed.
- During a six-second artificial worker CPU stall in the isolated test environment,
  30 real HTTP API reads all returned 200 (P95 61 ms, maximum 112 ms).
- Production browser checks loaded all five public entrypoints without page errors;
  booking rendered four service groups and all three bootstrap/catalog responses were 200.
- Production read sampling: 24 responses, all 200, P95 106 ms, maximum 125 ms.
- Observed production snapshot refreshes took 1,594 and 1,883 ms, compared with the
  incident's approximately 12–14 seconds. API event-loop P99 remained about 21 ms.
- Since 16:56:25 UTC in the post-release observation window, both Caddy logs showed
  no HTTP 5xx and no active-health-check timeouts. This is a bounded observation,
  not a guarantee against future failures.

## Deployment issue resolved

The first attempt stopped before changing API containers because historical
Supabase migration work had left `index.html` owned by root. The deployment script
now uploads each HTML entrypoint to a temporary file and atomically renames it in
the application-owned directory. It also validates custom image tags. Retrying
the deployment succeeded on both nodes, followed by a Cloudflare cache purge.

[Aggregate release evidence](../../artifacts/releases/2026-10-05-full-production.json)

[Deployed commit CI](https://github.com/geniefront/geniefront-os/actions/runs/37344523437)
