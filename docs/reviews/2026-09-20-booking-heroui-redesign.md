# Public booking UI — quiet silver redesign

Scope: storefront, service customization, guest selection, booking cart, specialist/time selection, contact/review/success, bundles, and SMS appointment detail/reschedule/cancel pages.

- Main flow: Services → Time → Confirm. Guest count lives beside services; the booking cart remains editable. Desktop uses a sticky side panel; mobile uses a fixed summary bar and Pro Sheet. Contact edits stay in memory during in-flow navigation.
- Services with explicit duration suffixes are grouped by exact base name and category; actual service IDs, prices and durations are preserved. Duration/add-ons use a modal, with existing selections restored when editing.
- HeroUI Pro 1.0.0-beta.10 supplies Stepper, Sheet and NumberStepper. HeroUI 3.2.6 supplies Calendar, Modal, Card, Button, Input, Checkbox and Avatar. Date selection never uses the browser's native date input.
- Store details and policies are disclosed on demand. No welcome slogans, invented ratings, stock staff photos or promotional filler.
- Existing API quotes, staff capacity, anti-bot verification, idempotency, error/retry handling, management tokens and phone verification remain in place.
- The configured shop's three add-ons were enabled in its public profile, with an audit entry: Hot Stones free, Table Shower $10, Essential Oils $10, each 10 minutes. They remain unavailable as standalone services.

## Verification

38 booking tests pass, including multi-guest atomic submission, service/add-on customization, stale availability responses, duplicate submission protection, token scope, reschedule and cancellation. Booking TypeScript and production Vite build pass.

Real-shop read-only browser check: 60-minute Swedish Massage plus Essential Oils totals $70 and reserves 70 minutes; September 24 availability loads. Mobile tested at 390×844: editable bottom cart, add-on modal, preserved selections. An isolated local synthetic appointment was created, rescheduled from September 22 to September 24 with the $45 price retained, then cancelled through the actual management UI. Local communication delivery uses capture mode; no real test SMS/email or production appointment was sent/created.

## Installation

`hpsetup react --auto --dry-run` preceded the booking-only install. Dependencies and Pro version are pinned where compatibility requires it; unused optional feature dependencies were removed. Automatic Pro lifecycle scripts are disabled; `scripts/prepare-heroui.mjs` restores the pinned artifacts through hpsetup's version-pinned cache/download implementation before frontend builds. It reads only private local credentials or HEROUI_KEY in CI. No credential is added to Vite variables, source files, or browser output. Credential scan passed.

Production deployed as `b0699b3-20260920144319` to gf-a and gf-b. Both health checks passed and edge cache was purged. Production browser inspection confirmed the three-step interface and the real duration/add-on modal for Zhi Zi Massage.
