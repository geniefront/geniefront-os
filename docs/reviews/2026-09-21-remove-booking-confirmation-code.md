# Booking confirmation code retirement

Removed customer-facing confirmation codes from booking success/management pages, the staff message view, public and voice responses, appointment creation (including Copilot batches), schemas, session persistence, and embed conversion events. Telephone success messages now refer to appointment details. Voice response schemas strip retired fields from pre-existing idempotency results. Management tokens, appointment IDs, and staff short links remain in use.

The forward migration `20260921184523_remove_booking_confirmation_code.sql` is mirrored in `packages/db/sql` and `supabase/migrations`. It drops the confirmation-code index and column. Historical migrations remain unchanged. Deploy application code without column reads/writes before applying the drop migration. Initial implementation verification used only the local isolated database; production rollout is recorded below.

## Verification

- Typechecks passed for API, booking, web, contracts, and DB; `pnpm lint:guards` and `git diff --check` passed.
- Booking frontend: 45 tests passed across 12 files.
- API integration: 260 passed, 6 failed across public booking, Telnyx phone, voice V1/V2, Copilot acceptance, and SMS suites. The public booking suite passed all 97 tests, including management, cancellation and rescheduling. Test configuration uses `BOOKING_PAGE_ORIGIN=https://book.geniefront.com` to match fixture origins.
- All six remaining failures reproduced on unmodified commit `725aab7` in a separate temporary worktree and isolated local database: the Telnyx two-guest staff-assignment assertion, and Copilot acceptance scenarios 1, 2, 3, 4 and 6. These are unchanged baseline failures.
- Migration applied to local isolated `gf_voice_ci`. SQL checks confirmed the confirmation-code column/index are absent while `manage_token_digest`, `manage_token_wrapped`, and `staff_link_code` remain. The temporary baseline database/worktree were removed afterward.

Integration command:

```sh
BOOKING_PAGE_ORIGIN=https://book.geniefront.com node --env-file=.env.local scripts/test-voice-local.mjs test src/public.test.ts src/phone.test.ts src/voice.test.ts src/voiceV2.test.ts src/copilot/acceptance.test.ts src/sms.test.ts
```

## Production rollout — 2026-09-21

- Pushed application commit `f6f64e6` to `origin/main`.
- Deployed `geniefront/api:f6f64e6-20260921185357` and production frontend assets to both `gf-a` and `gf-b`; both API containers report healthy.
- Applied the single pending production migration only after both servers were running the new application. Migration and RLS coverage checks passed.
- Production SQL verification confirmed the retired column/index are absent and management-token/staff-link columns remain.
- Cloudflare cache purge succeeded. Public booking assets match the local release and contain no confirmation-code fields/components. Booking page, manage page, hosted shop API, booking health and API health all returned HTTP 200.
- Verification was read-only; no customer appointment was created or changed.
