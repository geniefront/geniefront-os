# Booking UI and split hours

- Shared silver design tokens and components: `apps/booking/src/styles/booking-theme.css`; base compatibility styles separated. Durations use minutes throughout.
- Fixed media geometry and broken-image fallback for mixed service/add-on catalogs; distinct unchecked/checked controls; staff selection loading status.
- Store details include configured cover/gallery/description, ordered weekly periods, public active/bookable staff, address and phone. Missing shop media is not invented.
- GenieFront footer links to the homepage, contact screen links SMS/Privacy/Terms; marketing opt-in remains separate and false.
- Weekly hours accept legacy `{open,close}` and canonical `{open,close,periods:[...]}`. `periods` is authoritative; API normalizes the outer envelope and rejects overlapping intervals. No SQL schema migration is needed for existing JSONB. Existing shop hours are unchanged.
- Shared period editor covers onboarding, store settings and staff weekly schedules. Defaults retain shop hours. Public planning, rescheduling, voice offers and final booking validation respect breaks. Adjacent periods form one continuous window; overnight hours remain supported.
- Google and website imports preserve periods; AI store summaries include them.
- GitHub repository secret HEROUI_KEY configured via stdin (never printed). Workflow now prepares pinned Pro artifacts before typecheck and builds booking. Personal Token is local documentation tooling only. Current deployment builds locally and ships static assets through the existing origin/Cloudflare path; it does not need either secret in Cloudflare or client bundles. Workflow changes take effect when pushed.

Validation: workspace typecheck (16 packages); booking UI, contract, scheduling, API availability/recurrence and AI context tests; production build; browser desktop and 390px phone checks. Legal destinations return HTTP 200.

Production: `b0699b3-20260920151648`, both hosts healthy and Cloudflare cache purged. Live checks verified public staff, availability loading/completion, service customization, legal links and branding without creating a production appointment. Named-staff rescheduling regression covers both split shifts and rejects their break (256 relevant tests total across suites).
