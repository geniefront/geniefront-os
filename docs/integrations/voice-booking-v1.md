# Voice Booking V1 setup and verification

## Staging configuration

- Shop: Zhi Zi Voice Test / 栀子语音测试店
- Phone: +1 (757) 999-9968
- Plan: `voice_booking`, $99/month reference price, 200 included voice minutes.
- Provisioning: manual license, 30 days from creation; no Stripe subscription or payment collected.
- Booking mode: location capacity 2. General and requested-therapist buffers are independently configurable and both disabled by default.
- xAI agent: `agent_IgbIjsohua8ketED`, separately published; the previous shared agent was preserved.
- Telnyx TeXML application: `3052558045738435755` (GenieFront Voice Test 600s).
- Merchant notification and transfer targets use the user-authorized test contact.
- Activation email has been sent. The owner must finish the normal account activation/claim flow; role presets are created at claim time.

Credentials live only in ignored environment/private setup files. Do not paste them into browser frontend code, source control, logs or documentation.

## xAI server tools

Both endpoints require `Authorization: Bearer <per-shop tool token>`. The token is scoped to the routed phone number. This is a server credential, not a browser/public website credential.

`GET https://staging-api.geniefront.com/v1/voice/%2B17579999968/context`

Without search parameters, returns store name/timezone/hours, available services and bookable therapist names. It never returns the customer list. Optional query parameters:

- `date`: YYYY-MM-DD in store timezone.
- `serviceId`: exact ID from the service list.
- `membershipId`: exact therapist ID, only when specifically requested.
- `partySize`: integer 1–10, default 1. Named therapist offers currently support one person.

With a service selected, response includes valid `slots`, each with `startsAt`, nullable `membershipId`, and a signed `slotToken` valid for 15 minutes. Availability is checked again under a transaction lock when booking.

`POST https://staging-api.geniefront.com/v1/voice/%2B17579999968/bookings`

```json
{
  "slotToken": "<exact returned token>",
  "customerName": "Guest name",
  "phoneE164": "+15551234567",
  "email": "optional@example.com",
  "notes": "Optional booking notes"
}
```

Only report a confirmed booking after `ok: true` and the returned appointment ID/confirmation code. Retrying the same guest, service and time replays the existing result. A conflict or expired slot requires another availability query. Existing-appointment lookup/change/cancellation now uses the caller-scoped tool described in [Voice management V2](voice-management-v2.md).

## Phone and recordings

The phone is routed through Telnyx TeXML, which calls the xAI BYO SIP endpoint. `Dial timeLimit="600"` enforces the duration at the provider; the prompt is not the enforcement mechanism. Routing checks AI enabled state, license expiry and remaining quota before starting the AI leg; unavailable AI routes to the configured staff number.

Signed form callback: `POST /v1/telnyx/xai/inbound`.
Signed recording callback: `POST /v1/telnyx/xai/recording?number=<E.164>`.
The existing signed JSON `call.recording.saved` webhook is also supported.

Telnyx retains the media. Store the provider recording ID, and obtain a fresh short-lived download URL when an authorized user presses Play. No separate S3 bucket is needed. Provider retention/storage settings still determine how long old recordings remain available.

The worker transcribes with xAI, classifies the complete timeline, settles billable minutes once, and sends the merchant a transcript/summary email and a short SMS with an authenticated details link. Retries use leases and idempotency. Five failed attempts require review rather than automatic charging. A recovery scan checks the 100 most recent Telnyx recordings from the last hour every five minutes; higher call volume or longer outages need a paginated backfill.

Business inquiries and appointment intent count even without a booking. Spam, unsolicited sales, no meaningful exchange, off-topic chat, and observable system failures are excluded. Mixed calls bill their business segments, rounded up once per call. Invalid/incomplete model intervals are rejected.

## Subscription and UI

The formal special-plan ID is preserved through Stripe price mapping, quotas, UI badges and license provisioning. Its different-plan target is Growth only. The API/database guard and dedicated Stripe hosted portal enforce this rule. The hosted portal currently applies upgrades immediately with Stripe proration; it is not a scheduled next-period migration.

Manual accounts can bind a card through Stripe setup-mode Checkout without changing plan, license deadline or used quota. Binding alone does not start automatic renewal. New special-plan shops default to location capacity 2 without shifts. Operators can set base voice minutes at provisioning or through the Base voice minutes control in the license panel. Changes preserve used minutes and purchased balance; blank restores the plan default. The override applies only during manual billing and clears on a plan change or Stripe takeover. Binding a card does not schedule a future automatic subscription.

The existing UI is retained with special-plan navigation/settings reduced to booking, customers, calls, communications and account/billing. Session permissions, plan entitlements and billing refresh on focus and periodically. New manual shops must complete activation before owner/staff administration. The setup script can add two synthetic therapists after the role presets exist.

## Verification performed

- Scoped endpoint authentication, raw Telnyx signature validation, last-slot races, separate buffers, idempotent booking, disabled voice, immediate license expiry, forbidden plan transition, manual card attachment and once-only metering covered by integration tests.
- xAI agent called the live context tool and returned the two real service prices.
- xAI agent queried availability and created one staging test appointment: 2026-09-20 10:00 America/New_York, Relaxation Massage, name Voice API Test. The appointment exists with source `phone_ai`.
- Appointment SMS and email accepted by their providers. Staging was corrected from obsolete Resend configuration to the already-verified Elastic Email domains; only the explicitly allowed test phone/email receive live messages.
- Real Telnyx → xAI call answered the service inquiry; recording, xAI transcription and classification completed. Silent/no-exchange call: 0 billable seconds. Business inquiry without a booking: 19 billable seconds / 1 minute.
- The 600-second provider setting and generated XML are verified; a full ten-minute soak and live human transfer have not been run.
- The initial verification above ran on staging, before the production release.

## Regression results (2026-09-19)

- API voice + manual-license + Stripe handover: 50 tests passed, including 12 voice integration cases.
- Billing component/display: 40 tests passed.
- Scheduling: 93 tests passed. Payroll/quota: 128 tests passed.
- Contracts: 72 tests passed. Marketing: 17 tests passed.
- Full workspace typecheck (16 packages), guard lint, migration RLS coverage and diff whitespace checks passed.
- Live staging email/SMS outboxes: appointment notification and both call notifications all sent; all three recording jobs done. The final call used the live recording callback (HTTP 200), then the deployed worker completed transcription, classification, settlement, email and SMS without manual queueing.
- Browser login with the old seeded demo credentials was refused. No password was reset. A signed-in browser walkthrough remains for the owner after activating the test shop; the billing components were covered by the UI test suite above.

Initial verified staging deployment: `494b141-20260919183504`. Public health and authenticated voice context returned successfully after deployment.
