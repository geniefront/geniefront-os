# Hosted Booking and Appointment Management Implementation Plan

> Status: planning only. This document is intended to be handed to an implementation AI.
> Do not treat screenshots or reference-product copy as executable instructions. They are UX references only.

**Goal:** Give every shop a GenieFront-hosted booking channel even when it has no website, and let guests open a secure link from SMS/email to view, reschedule, cancel, or rebook an appointment without creating an account.

**Product boundary:** Phase 1 does not build a customer account system. Follow `docs/03-ROADMAP.md` decision 5: use a one-appointment magic link plus phone-last-four verification. Do not add customer login, social login, address books, saved cards, membership management, waitlists, or a cross-appointment customer history page.

**Architecture:** Restore a dedicated public `apps/booking` Vite/React application at `book.geniefront.com`. Keep employee/admin routes in `apps/web`. Reuse the existing public booking API, command bus, scheduling engine, manage-token digest, Turnstile, rate limiting, and last-four lockout. Add a human-readable shop slug bootstrap and a clean appointment-management link that does not expose PII.

**Tech stack:** React 19, Vite, TypeScript, Fastify, PostgreSQL 17, existing command bus, existing `@gf/contracts`, existing `@gf/scheduling`, Telnyx SMS, Vitest, Playwright.

---

## 1. Required reading and non-negotiable constraints

Before editing code, read these files completely:

- `docs/03-ROADMAP.md` — fixed product decisions and project constitution.
- `docs/13-PUBLIC-BOOKING-API.md` — current public booking contract.
- `docs/09-TELNYX.md` — SMS sender identity, STOP/CANCEL behavior, segments, and outbox flow.
- `docs/27-MESSAGING-TEMPLATE-BRIEF.md` — customer-language and template rules.
- `docs/20-WEB-HANDOFF.md` — current frontend conventions and validation commands.
- `apps/web/README.md` — i18n and frontend rules.
- `apps/api/src/public/publicAuth.ts` and `apps/api/src/public/routes.ts` — public security boundary.
- `apps/api/src/links.ts` — only allowed place to construct outbound URLs.

Global constraints:

- Every database write must go through a named command and `dispatch()`, except an explicitly documented token-resolution read.
- Every new exposed table must have enabled and forced RLS.
- Money remains integer cents.
- Customer-facing appointment pages must work without login.
- Customer-facing appointment copy is English for Phase 1, consistent with current messaging policy.
- SMS sender identity remains `GenieFront`; the shop name appears in the message body.
- Never instruct a guest to reply `CANCEL`. `CANCEL` is an opt-out keyword, not an appointment action.
- Keep `Reply STOP to unsubscribe` in outbound SMS according to the existing messaging policy.
- SMS failure must never roll back booking, rescheduling, or cancellation.
- Public booking never receives an override path and can never overbook.
- Public time rendering must always use the shop IANA timezone, not the browser timezone.
- The system does not collect appointment deposits, store customer cards, or perform online checkout.
- Do not expose customer lookup by phone number.
- Do not place customer name, phone, email, or raw appointment details in public URL paths.
- Do not enable `BOOKING_MANAGE_PAGE_ENABLED=1` until the production management route is deployed and verified.

---

## 2. User journeys and route contract

### 2.1 Shop booking link

Canonical public URL:

```text
https://book.geniefront.com/{shop-slug}
```

Optional iframe URL for shops that later acquire a website:

```text
https://book.geniefront.com/{shop-slug}?embed=1
```

The guest flow is:

```text
Services -> Specialist -> Time -> Contact/Confirm -> Success
```

Requirements:

1. Show shop name, address, phone, and booking availability status.
2. Show categories, primary services, duration, price, description, and add-ons.
3. Support any specialist, one specialist per service, and a named specialist.
4. Show slots in the shop timezone.
5. Preserve existing idempotency, Turnstile, honeypot, elapsed-time, rate-limit, and stale-slot handling.
6. Show the confirmation code immediately after booking.
7. Show a same-session link to the management page.
8. Keep the shop phone visible on every error and disabled-booking state.

### 2.2 Appointment management link

Canonical outbound link:

```text
https://book.geniefront.com/l/{shop-slug}/g/{opaque-manage-token}
```

The token is random and unguessable. Store only its SHA-256 digest in the appointment row. The URL must not contain the customer phone, customer name, email, raw public key, or a sequential appointment number.

Opening the link may show non-sensitive appointment summary information. Reschedule and cancel actions require phone-last-four verification. Reuse the current rules:

- Three failed attempts lock the appointment for 15 minutes.
- Lockout is appointment-scoped, not IP-scoped.
- Cancellation respects `cancelCutoffHours`.
- Rescheduling respects `rescheduleEnabled`, `rescheduleCutoffHours`, and `selfRescheduleMax`.
- Rescheduling is atomic and excludes the current appointment when calculating availability.

State behavior:

| Appointment state | Available guest actions |
| --- | --- |
| `booked` | Reschedule, cancel, book another |
| `cancelled` | View status, book again |
| `completed` / `done` | View status, book again |
| `no_show` | View status, call shop, book again |
| too close to cutoff | View status, call shop |

The same link remains useful after cancellation. It must open a cancelled-state page instead of returning a dead link.

### 2.3 Deliberately deferred customer-portal features

Do not implement these in this plan:

- customer registration or passwords;
- Google/social login;
- a list of all appointments associated with a phone number;
- profile editing, addresses, payment methods, memberships, or waitlists;
- stored payment cards or customer checkout.

Those reference-product screens are Phase 2 candidates and require a separate identity/privacy design.

---

## 3. Current implementation facts

Do not rediscover or reimplement these existing capabilities:

- Public shop/services/availability/create/get/cancel/reschedule routes already exist in `apps/api/src/public/routes.ts`.
- Public-key tenant resolution exists in `packages/db/src/publicBooking.ts`.
- Manage tokens and confirmation codes exist in `apps/api/src/public/bookingToken.ts`.
- `appointments.manage_token_digest` and `appointments.confirmation_code` already exist.
- Last-four verification and lockout exist in `apps/api/src/public/routes.ts`.
- Atomic `appointment.reschedule` and `appointment.cancel` handlers already exist.
- Confirmation email link construction is gated through `apps/api/src/links.ts`.
- The prior `apps/booking` application exists in Git history before commit `4cf09d8`; use it only as a behavioral reference. Do not restore it blindly because it has hard-coded Chinese copy and does not implement the new management route.
- `apps/web/src/pages/Settings.tsx` already exposes public keys, domain allowlists, online-booking rules, and a shop slug, but does not provide a merchant-friendly hosted booking card.
- Production deployment currently builds and serves web, kiosk, platform, and marketing only. It does not build or serve a booking app.

Known gaps to fix:

- `apps/booking` is absent from the current tree.
- `/b/:id` or an equivalent management page is absent.
- `BOOKING_MANAGE_PAGE_ENABLED` is intentionally disabled.
- Confirmation SMS currently says to call the salon and does not contain a management link.
- Appointment changed/cancelled template variables do not currently include `manage_url`.
- Shop slug is not globally unique or safely resolvable as a public route.
- The public booking-detail response is too small for the requested management UI.
- Cancellation notification data must be captured before all appointment items become `cancelled`; otherwise service/time joins can become null.

---

## 4. Task sequence

Implement tasks in this order. Each task must keep the repository buildable and must add tests before moving to the next task.

### Task 1: Public slug contract and migration

Primary files:

- `packages/db/sql/0095_hosted_booking_slug.sql` — new migration; use the actual next migration number if another migration lands first.
- `packages/db/src/schema/tenancy.ts`
- `packages/contracts/src/commands/setup.ts`
- `apps/api/src/handlers/setup.ts`
- `apps/api/src/queries/settings.ts`
- related DB/API tests.

Implementation:

1. Define one canonical normalization function for shop slugs:
   - lowercase ASCII;
   - letters, digits, and single hyphens only;
   - trim leading/trailing hyphens;
   - length 2–64;
   - reject reserved paths such as `l`, `g`, `b`, `assets`, `api`, `public`, `health`, `login`, and `admin`.
2. Add a platform-wide unique index on normalized `locations.slug`.
3. Migrate existing duplicate or invalid slugs deterministically by appending a stable short suffix. Never silently point an existing link at a different shop.
4. Validate uniqueness in `location.saveProfile` and return a specific, translatable validation reason such as `slug_unavailable`.
5. Keep public key behavior unchanged. The slug is a human-readable lookup key, not an authorization secret.

Acceptance tests:

- two organizations cannot save the same canonical slug;
- case and punctuation variants collide after normalization;
- reserved slugs are rejected;
- existing valid slugs do not change;
- migration is replay-safe.

### Task 2: Resolve hosted shop by slug without broadening tenant access

Primary files:

- `packages/db/src/publicBooking.ts`
- `apps/api/src/public/publicAuth.ts`
- `apps/api/src/public/routes.ts`
- `apps/api/src/public.test.ts`

Implementation:

1. Add a narrowly scoped slug-resolution read that returns only the same `PublicShopRow` currently returned by public-key resolution.
2. Add a bootstrap endpoint such as:

   ```http
   GET /public/v1/hosted/shops/:slug?locale=en
   ```

3. The endpoint may return the public key because that key is explicitly public, but the frontend should keep it in memory rather than placing it back into the canonical URL.
4. Return the same generic `404 NOT_FOUND` for nonexistent, setup, suspended, or closed shops.
5. Do not grant slug-based access to customer, appointment, reporting, or configuration tables.
6. Preserve hosted-origin behavior in `apps/api/src/public/origin.ts`.

Acceptance tests:

- valid active shop resolves;
- setup/suspended/closed/nonexistent shops all have the same externally visible response;
- resolved public key cannot call authenticated routes;
- slug resolution does not expose allowed-origin configuration or private shop settings.

### Task 3: Stable management-token resolution

Primary files:

- `packages/db/sql/0096_manage_token_resolution.sql` if a migration is required;
- `packages/db/src/publicBooking.ts` or a focused new `packages/db/src/bookingManage.ts`;
- `apps/api/src/public/bookingToken.ts`;
- `apps/api/src/public/publicAuth.ts`;
- `apps/api/src/public/routes.ts`;
- API tests.

Implementation:

1. Reuse `appointments.manage_token_digest`; do not introduce a second competing token system without a concrete need.
2. Add a narrow token-digest resolution path that can identify the appointment's org/location, then switch immediately into normal `withTenant()` context.
3. If required for safe lookup, add a global partial unique index on non-null `manage_token_digest`.
4. Change the management frontend/API contract so the raw token alone can bootstrap the appointment; do not require `?k=pk_...` in the public URL.
5. Preserve the existing generic-not-found behavior for wrong token, wrong shop, missing appointment, or disabled shop.
6. Keep raw tokens out of audit records, structured logs, error payloads, analytics events, and referrer headers.
7. Add `Referrer-Policy: no-referrer` to management pages.

Acceptance tests:

- a valid token resolves exactly one appointment and shop;
- a wrong token does not confirm whether an appointment exists;
- another tenant cannot reuse the token with a different slug;
- token values never appear in audit payload assertions or application logs;
- cancelled appointments remain resolvable.

### Task 4: Issue management links for customer-linked appointments

Primary files:

- `packages/contracts/src/commands/appointment.ts`
- `apps/api/src/handlers/appointment.ts`
- `apps/api/src/telnyx/routes.ts`
- `apps/api/src/links.ts`
- related handler/link tests.

Implementation:

1. Preserve existing web and phone-AI guest-token generation.
2. For desk/phone-manual appointments with a real customer phone, generate a management token inside the appointment-create transaction when no token was supplied.
3. Store only the digest on `appointments`; retain the raw token only long enough to construct queued transactional notifications.
4. Do not put the raw token in command output or command audit output.
5. Add one centralized outbound link helper, for example:

   ```ts
   manageBookingUrl({ shopSlug, manageToken })
   ```

6. Remove the public key and appointment ID from new outbound URLs.
7. Keep old link parsing temporarily if any previously sent development/staging links may still exist.

Acceptance tests:

- web, phone-AI, desk, and phone-manual appointments with a phone get a working management link;
- anonymous walk-ins or appointments without a phone do not get a management link;
- idempotent command replay does not create a second appointment or send a second confirmation;
- raw token is absent from the command result and audit log.

### Task 5: Enrich the public appointment-detail contract

Primary files:

- `apps/api/src/public/routes.ts`
- `apps/api/src/public.test.ts`
- optional public response schemas in `packages/contracts` if shared with the frontend.

The management-detail response must include only what the page needs:

- booking ID internally, not necessarily rendered;
- confirmation code;
- appointment status;
- shop name, slug, phone, address, timezone, and currency;
- service and add-on names;
- price snapshot in integer cents;
- duration;
- specialist display name only;
- starts/ends timestamps with offsets;
- policy values;
- `actions` computed by the server, for example:

  ```json
  {
    "canReschedule": true,
    "canCancel": true,
    "canRebook": true,
    "reason": null,
    "rescheduleCountLeft": 1
  }
  ```

Do not return:

- customer phone or email;
- staff phone or legal name;
- notes or health-form data;
- other appointments;
- internal membership, org, or location identifiers unless the mutation contract strictly requires them.

Fix cancellation notification data ordering in this task: capture service, time, staff, phone, and manage URL before appointment items are marked cancelled, or query cancelled items deliberately by stable sequence rather than filtering them out.

Acceptance tests:

- booked/cancelled/completed/no-show responses return correct state and actions;
- cancellation responses retain original service and appointment time;
- a forwarded link does not expose phone/email;
- cutoffs and reschedule-limit reasons match mutation behavior.

### Task 6: Recreate the dedicated booking application

Primary files:

- new `apps/booking/package.json`
- new `apps/booking/vite.config.ts`
- new `apps/booking/tsconfig.json`
- new `apps/booking/index.html`
- new `apps/booking/src/**`
- `apps/README.md`
- root scripts only if needed.

Implementation rules:

1. Use the old app from Git history only as a checklist for:
   - idempotency key lifetime;
   - stale-slot `409` handling;
   - Turnstile reset after failure;
   - shop-timezone formatting;
   - iframe height messages;
   - honeypot and elapsed time.
2. Do not copy its hard-coded Chinese UI or obsolete cancel-only success screen.
3. Build a mobile-first interface matching the requested behavior:
   - desktop: main step area plus sticky appointment summary;
   - mobile: one column with a sticky bottom action area;
   - clear progress: Services, Specialist, Time, Confirm;
   - large touch targets and keyboard-visible focus states.
4. Preserve the existing product visual system where appropriate, but keep the consumer page lighter than the employee dashboard.
5. Use existing dependencies where compatible. Do not add a second server-state library; TanStack Query is already established in the repo.
6. Support direct and iframe modes.
7. In iframe mode, continue to publish `gf-booking:height` and `gf-booking:booked` messages.
8. Do not open the employee session/auth stack in this app.

Required page states:

- loading;
- shop not found;
- booking disabled;
- no online-bookable services;
- no specialists;
- no slots today, with next-available-day behavior;
- stale slot / capacity conflict;
- rate limited;
- Turnstile failure;
- network/API failure with shop phone;
- success with confirmation code and management link.

Frontend tests:

- service plus add-on changes duration and reloads availability;
- any/named specialist selection is sent correctly;
- shop timezone controls displayed dates/times;
- a `409` returns to time selection and reloads slots;
- double-click submit creates one request with one idempotency key;
- Turnstile resets after a failed submission;
- success stores only the minimum same-session data;
- embed postMessage events contain no customer PII or manage token.

### Task 7: Build the appointment management UI

Primary files:

- `apps/booking/src/pages/ManageBookingPage.tsx` or equivalent;
- booking app router;
- focused API client and components;
- frontend tests.

Implementation:

1. Route `/l/:slug/g/:token` outside any auth gate.
2. Set `document.title` from the shop and mark the page `noindex,nofollow`.
3. Apply `Referrer-Policy: no-referrer` before loading third-party resources.
4. Show status, shop contact, service summary, specialist, local date/time, price, duration, and policy.
5. Require phone-last-four before the first mutation. Do not persist last four in localStorage.
6. Reschedule flow:
   - load availability using the existing service/add-ons;
   - pass `excludeAppointmentId` or the current equivalent;
   - confirm the selected new time;
   - call the atomic reschedule endpoint;
   - refresh detail and show success.
7. Cancel flow:
   - show the shop cancellation policy;
   - require explicit confirmation;
   - call the idempotent cancel endpoint;
   - refresh into cancelled state.
8. Rebook flow:
   - start a new booking for the same shop;
   - optionally preselect the same service, but always reload current price, duration, and availability.
9. Never treat the old appointment price/time as authority for a new booking.

Frontend tests:

- correct/incorrect/locked last-four states;
- reschedule disabled/cutoff/limit states;
- cancellation cutoff state;
- successful reschedule updates displayed time;
- successful cancellation becomes read-only and offers rebook;
- completed/no-show appointments cannot be mutated;
- invalid token shows a generic error plus shop contact when available.

### Task 5 corrections / Task 8 `manage_url` design lock

The database stores only `manage_token_digest`. SHA-256 cannot reconstruct the
raw token, so later merchant-initiated reschedule, cancellation, and reminder
notifications cannot rebuild `/l/{slug}/g/{token}` from the row.

Locked design (implemented at issuance in the Task 5 correction; consumed in Task 8):

1. Issuance still generates a random `mt_…` token.
2. Lookup and validation stay digest-based. Do not weaken comparison.
3. Store AES-256-GCM ciphertext in `appointments.manage_token_wrapped`.
   Key is HKDF-SHA-256 of `APP_JWT_SECRET` with info `gf-manage-token-wrap:v1`.
   Helpers: `wrapManageToken` / `unwrapManageToken` in `bookingToken.ts`.
4. Task 8 unwraps inside the notification enqueue path and passes the raw
   token to `hostedManageBookingUrl`. Never log the token or the blob.
5. If wrap/unwrap is impossible (missing secret, legacy row, corrupt blob,
   digest mismatch): omit `manage_url`. **Never mint a replacement token.**
   Previously issued confirmation links must keep working.

Task 8 acceptance tests for this design:

- `appointment_confirm`, `appointment_changed`, `appointment_cancelled`, and
  `appointment_reminder` bodies contain the same `/l/{slug}/g/{token}` as
  issuance when unwrap succeeds;
- missing wrap or failed unwrap omits `manage_url` rather than rotating the token;
- raw token is absent from audit, structured logs, and analytics;
- a guest who already has the confirmation link can still open it after a
  later merchant reschedule or cancellation notification.

### Task 8: Add management links to transactional messaging

Primary files:

- `apps/api/src/sms/render.ts`
- `apps/api/src/handlers/appointment.ts`
- `apps/api/src/notify/dispatch.ts`
- `packages/contracts/src/notification.ts`
- new migration after `0093` to refresh only unmodified default templates;
- `docs/27-MESSAGING-TEMPLATE-BRIEF.md`
- SMS/notification tests.

Required customer events:

- appointment confirmed;
- appointment changed/rescheduled;
- appointment cancelled;
- appointment reminder.

Add `manage_url` to the supported variables for all four events. Preserve customized shop templates; refresh only rows that still exactly equal an old default.

Recommended message intent:

```text
GenieFront: Your appointment at Grace Spa is confirmed.
View, cancel, or reschedule: {{manage_url}}
This is an automated message. Reply STOP to unsubscribe.
```

```text
GenieFront: Your Grace Spa appointment has been cancelled.
View details or book again: {{manage_url}}
This is an automated message. Reply STOP to unsubscribe.
```

Exact final wording must pass the repository's SMS character/segment tests. Measure longest realistic shop and service names. A management link may justify more than one segment, but the implementation must record and expose the true segment cost; do not pretend it still fits one segment.

Additional rules:

- never say `Reply CANCEL`;
- sender identity remains `GenieFront`;
- cancellation link remains valid and leads to a cancelled/rebook screen;
- automated-message language must not imply replies are read by the shop;
- STOP/HELP behavior remains owned by the existing Telnyx keyword flow;
- notification failure remains non-throwing and cannot roll back the command.

Acceptance tests:

- all four customer event bodies contain the correct management URL when available;
- no event contains `Reply CANCEL`;
- every outbound SMS contains sender identity and STOP language;
- segment count stored in `sms_outbox` equals `segmentsOf(body)`;
- no link is emitted when there is no safe management token;
- customized templates are not overwritten by migration.

### Task 9: Merchant-facing hosted booking controls

Primary files:

- `apps/web/src/pages/Settings.tsx`
- `apps/web/src/features/settings/api.ts`
- `apps/web/src/features/settings/types.ts`
- `apps/web/src/i18n/settings.ts`
- settings tests.

Create a normal merchant-facing section titled "Online booking channel" or the localized equivalent. Keep technical public-key/origin controls in the developer/integrations area.

The merchant section must provide:

- master online-booking switch;
- canonical hosted booking URL;
- Copy link;
- Open preview;
- QR code preview/download;
- editable public slug with availability feedback;
- count of online-bookable services;
- allow guest to choose specialist;
- cancel cutoff;
- reschedule enabled/cutoff/max count;
- clear explanation that this link works even without a shop website;
- suggested placements: Google Business Profile, Yelp, Instagram, SMS signature, and printed front-desk QR.

Do not show a fake fallback key or fake URL in production UI. If settings are unavailable, render a proper error state.

Acceptance tests:

- copy/open/QR all use the same canonical URL;
- unavailable/reserved slug errors are understandable;
- turning off online booking preserves existing management links;
- developer public key remains available in integrations but is not required for normal hosted-link setup.

### Task 10: Deploy and serve `book.geniefront.com`

Primary files:

- `deploy/deploy.sh`
- `deploy/Caddyfile`
- `.env.example`
- `.env.local.example`
- `.env.staging.example`
- `.env.production.example`
- `scripts/env-guard.sh`
- any CI build filters that enumerate apps.

Implementation:

1. Add `BOOKING_HOST` to environment validation and deployment.
2. Build `@gf/booking` in staging and production.
3. Sync `apps/booking/dist` to its own remote directory.
4. Serve it from `book.geniefront.com` with SPA fallback.
5. Route `/public/*` and API requests consistently to Fastify if the app uses same-origin requests; otherwise use the configured API origin and verify CORS.
6. Configure headers by route:
   - booking entry pages may be embedded, so do not send `X-Frame-Options: SAMEORIGIN` there;
   - management pages must not be embeddable; send `Content-Security-Policy: frame-ancestors 'none'` and/or `X-Frame-Options: DENY`;
   - management pages use `Referrer-Policy: no-referrer`;
   - static hashed assets remain immutable;
   - SPA HTML remains `no-cache`.
7. Add `book.geniefront.com` and staging equivalent to Turnstile allowed hostnames.
8. Verify Cloudflare DNS/LB/origin certificate coverage before production cutover.

Acceptance tests:

- direct refresh of `/{slug}` and `/l/{slug}/g/{token}` returns the SPA;
- booking entry can be embedded by a test merchant origin;
- management route refuses framing;
- hosted origin passes public API origin checks without merchant configuration;
- staging never emits production management links.

### Task 11: Documentation and compatibility cleanup

Primary files:

- `docs/13-PUBLIC-BOOKING-API.md`
- `docs/01-ARCHITECTURE.md`
- `docs/17-STOREFRONT-BRIEF.md`
- `docs/20-WEB-HANDOFF.md`
- `apps/README.md`
- `.env.example` comments.

Update stale statements:

- `apps/booking` is available again and where it is deployed;
- canonical merchant URL is slug-based;
- management link is live and no longer requires `k` query parameters;
- SMS confirmation includes a management link;
- phone verification remains optional/deferred unless separately implemented;
- full customer accounts remain intentionally out of scope.

Keep old public-key iframe/API documentation for third-party custom websites.

---

## 5. Verification plan

Run cheap/static checks first. Do not run integration tests against dev or production databases.

```bash
pnpm lint:guards
pnpm typecheck
pnpm test:unit
pnpm --filter @gf/booking test
pnpm --filter @gf/booking build
pnpm --filter @gf/web build
pnpm --filter @gf/api exec vitest run src/public.test.ts src/links.test.ts src/sms.test.ts src/notify.test.ts
```

Database/API integration tests require an explicitly isolated test database:

```bash
DATABASE_TEST_TARGET=isolated \
TEST_DATABASE_URL=... \
TEST_MIGRATION_DATABASE_URL=... \
pnpm verify
```

Required browser E2E scenarios:

1. A shop with no website copies its hosted URL and books from a mobile viewport.
2. A guest in `America/Los_Angeles` books a shop in `America/New_York`; every displayed time remains New York time.
3. A stale slot produces `409`, reloads availability, and preserves entered contact information safely.
4. Confirmation SMS capture contains the correct hosted management link.
5. Management link opens, wrong last four fails, correct last four reschedules.
6. Two guests compete for the same new slot; one succeeds and the other keeps the original appointment.
7. Cancellation changes both appointment and items to cancelled and sends the correct original service/time in the notification.
8. Opening the same link after cancellation shows cancelled plus Rebook.
9. Closing online booking blocks new bookings but does not block management of already-booked appointments.
10. SMS provider failure leaves the successful appointment mutation committed.
11. Link/token never appears in console output, analytics payloads, or outgoing referrers.
12. Booking entry iframe resizes correctly; management page cannot be framed.

---

## 6. Rollout and feature gates

Roll out in this exact order:

1. Merge database/API compatibility work with `BOOKING_MANAGE_PAGE_ENABLED` still off.
2. Deploy the booking app to staging.
3. Run full staging E2E with captured email/SMS.
4. Deploy the booking app to production while message links remain off.
5. Verify production `/shop-slug` and management routes using a test tenant and non-customer phone.
6. Set `BOOKING_MANAGE_PAGE_ENABLED=1` only after the route is confirmed live.
7. Enable for one pilot shop.
8. Monitor link opens, detail-load failures, last-four lockouts, reschedule conflicts, cancellations, SMS delivery, and segment cost.
9. Expand to all shops after the pilot has no broken-link or cross-tenant findings.

Rollback behavior:

- Turning `BOOKING_MANAGE_PAGE_ENABLED` off must stop new messages from receiving management links.
- Previously issued links should continue to work if the booking app remains deployed.
- Turning off online booking must block new appointments but must not block view/cancel/reschedule for existing appointments.

---

## 7. Definition of done

The work is complete only when all of the following are true:

- A shop with no website has a copyable `book.geniefront.com/{slug}` URL and QR code.
- A guest can book service, specialist, date/time, and contact information on mobile.
- The appointment appears in the existing front-desk schedule through the normal command path.
- The guest receives an SMS/email management link.
- The link opens without a GenieFront customer account.
- The guest can view accurate appointment details.
- Phone-last-four verification protects reschedule and cancel.
- Reschedule is atomic and conflict-safe.
- Cancelled/completed/no-show links remain useful and cannot mutate invalid states.
- Cancellation messages preserve original service and appointment time.
- No customer lookup by phone exists.
- No customer PII or raw token leaks into logs, analytics, audit records, or referrers.
- SMS failure cannot roll back appointment state.
- `book.geniefront.com` is built and served by the production deploy path.
- `BOOKING_MANAGE_PAGE_ENABLED=1` is enabled only after production route verification.
- Full customer accounts, payment methods, memberships, and appointment history remain out of scope.

---

## 8. Suggested effort breakdown

For one developer already familiar with this repository:

| Workstream | Estimate |
| --- | ---: |
| Slug/token/API foundation | 3–4 days |
| Hosted booking application | 4–6 days |
| Management page | 3–4 days |
| Messaging and merchant settings | 2–3 days |
| Deployment, E2E, pilot fixes | 2–3 days |
| **Total** | **14–20 working days** |

This estimate excludes a full customer account/profile system and online payment processing.
