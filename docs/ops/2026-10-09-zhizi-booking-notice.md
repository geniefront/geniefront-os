# Zhi Zi booking notice — 2026-10-09

At the owner's request, Zhi Zi Massage (`va-zhi-zi-massage`, location
`1c708a61-b467-4062-af96-2cd6392e20e5`) now accepts new bookings without a
minimum advance-notice interval. Production previously returned 90 minutes
through both public booking and the voice catalog.

The committed `scripts/zhizi-booking-lead-time.ts` rollout changes the store's
shared `online_booking.min_minutes_ahead` to 0 through the audited
`settings.saveVoiceBookingRules` command and requests a voice snapshot refresh.
It verifies that the rest of the settings match their original values. The
existing 10-minute slot interval, 30-day booking horizon and cancellation rules
are preserved. Other stores are unaffected.

This is a production configuration deployment; no application image replacement
or database schema migration is needed. Both existing API nodes use the shared
setting. The voice worker regenerated its snapshot at 2026-10-09 13:54:47 UTC.

Verification:

- The public hosted-shop endpoint reports `minMinutesAhead: 0`.
- Both production nodes report 0 in the stored rules, live voice catalog and
  initial voice-context snapshot. Both health endpoints return `ok: true`.
- 29 focused public-availability, voice-boundary and snapshot tests pass;
  API TypeScript checks and `git diff --check` pass.
- New regressions verify that zero notice allows an imminent available slot
  while continuing to reject past slots.

No real customer appointment or phone call was created for verification.
