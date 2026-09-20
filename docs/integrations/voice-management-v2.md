# Caller-scoped voice appointment management

The xAI agent uses the same appointment cancellation/rescheduling commands and guest policies as the public booking page. There is no extra AI approval queue. Existing legacy Telnyx assistant tools retain their explicit shop-configured review policy.

## Provider identity

The per-shop `Authorization: Bearer <tool token>` is a fixed server header. Add these **System** parameters to the API request tool, both in **Header**:

| Header | xAI system variable |
| --- | --- |
| `x-gf-caller-number` | `caller_number` |
| `x-gf-call-start-time` | `call_start_time` |

Never create model-generated parameters for these values. Missing/anonymous caller ID, malformed numbers, expired calls and web-playground calls without phone metadata cannot read or change appointments. Asking the caller to say another phone number does not authorize that number's bookings.

Authorization binds the routed shop, normalized calling number and current call. Selection tokens expire after 15 minutes and are unusable in another call, for another number or at another shop. The appointment and customer phone are checked again under database locks before writes. Original time and reschedule count protect against stale choices. A single verified number can select among its own upcoming bookings, including web, voice, manual-phone and desk bookings.

## One API tool

Name: `manage_my_appointment`

Method: `POST`

URL: `https://<environment-api>/v1/voice/<encoded-shop-phone>/appointments/{action}`

`action` is a generated path variable restricted by the routes to:

| action | Generated body fields | Result |
| --- | --- | --- |
| `lookup` | none | Own upcoming bookings, services, times, policy actions and `appointmentToken` |
| `availability` | `appointmentToken`, `date` (YYYY-MM-DD) | Whole-booking available times and a `changeToken` per slot |
| `cancel` | `appointmentToken`, `confirmed: true` | Cancellation result |
| `reschedule` | `changeToken`, `confirmed: true` | Reschedule result |

All four generated body fields are optional in the shared tool definition, but required by the corresponding server action. `confirmed` has Boolean type; the three other fields have String type. Omit irrelevant fields, do not send nulls or empty strings. `GET /appointments` is also available for server integrations.

The agent must first run lookup, ask which booking if multiple exist, and read back the selected services/date/time. It must obtain explicit confirmation before cancellation or moving the entire booking. It must use returned tokens verbatim and only offer returned availability. A failed request does not change the booking; offer staff help when policy or identity prevents self-service. Only `ok: true` authorizes a spoken success statement. Do not claim SMS/email delivery: the backend queues notifications and applies existing consent/opt-out rules.

## Policy and notifications

- Same cancellation cutoff, reschedule enablement/cutoff/count, booking horizon, opening hours, staff availability, resources and capacity as guest self-service.
- Group services move/cancel atomically; no override or separate AI capacity exception.
- Retries are idempotent and do not increment counts or enqueue duplicate notifications.
- Customer and shop notifications use the existing normal booking renderer. Customer SMS contains no management link or AI label. Email retains the guest management link when available. No email is required.
- An explicit saved SMS refusal or STOP is preserved by the shared delivery layer.

## Verification

Integration tests cover required system identity, same-phone lookup, other-number/call rejection, token tampering, explicit confirmation, cutoff/count limits, stale ownership/state, capacity races, notification deduplication, no-email cases and web/manual source parity. The existing public and voice booking suites run against an isolated database with communication delivery mocked/captured.
