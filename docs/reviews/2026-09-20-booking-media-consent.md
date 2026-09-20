# Booking media and SMS consent

Delivered to production `b0699b3-20260920155056`; both hosts healthy, Cloudflare cache purged.

- Explicit, optional, unchecked appointment SMS checkbox; separate `bookingSmsConsent` from marketing `smsOptIn`. The public booking API persists the decision/time/policy version on appointment items. Declining never blocks booking and suppresses customer confirmation, update and reminder texts. Shop/staff recipients are unaffected. Legacy/voice bookings without this new field retain existing behavior.
- Notes textarea has explicit 16px/18px padding, normal font weight and 1.65 line-height.
- Eight built-in image_gen assets, visually inspected and optimized to JPEG (~1.6 MB combined). Subjects: massage, nails, foot massage, spa still life, hot stones, table shower, essential oils and couples massage. Source and exact prompts: `artifacts/booking-media-prompts.json`. Final files: `apps/booking/public/media/defaults/*-v1.jpg`.
- Merchant overrides take priority. Missing images are inferred from service/category names with a spa fallback. Merchant library picker supports categories, automatic defaults and the existing authenticated custom upload flow. Available in onboarding, voice-plan service editor, normal-plan service modal and public profile settings. Store photos/description editor is also available in the voice-plan store settings with autosave.
- Scoped production transaction configured Zhi Zi Massage's cover, three gallery images, shop introduction and all 12 active services' photos/descriptions. Prices, durations and online-bookable state preserved (couples service remains contact-only). Previous profile is backed up privately; audit log records before/after. A separate DB read verified all 12, and public API verified all 11 publicly exposed items have both image and description.
- Store cover/gallery use generic service imagery, not purported photos of this business's premises.

Validation: 16-package workspace typecheck; 39 booking UI tests; 88 contract tests; public booking suite (94 then added presentation round-trip test), SMS claim suite (3), explicit follow-up reminder suppression regression, merchant image picker test. Production builds and browser checks of notes/SMS control, service images and store overview passed. No production appointment or outbound test message was created.
