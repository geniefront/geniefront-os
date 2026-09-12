# Front desk intake, checkout and room assignment

- Replaced runtime use of preset health summaries with validated five-language AI summaries of actual questionnaire answers. Shared summaries are encrypted alongside submissions, respect existing content permissions/access logs, and are cleared on answer erasure/change. Model input omits standard identity/contact/signature fields. Provider failure preserves the original form and displays unavailable status.
- Check-in loads the latest valid form summary automatically and allows switching forms. Appointment details, intake review, seating and service-brief printing use the server summary. Printing includes all applicable latest forms and their raw answers as fallback.
- Checkout accepts PostgreSQL numeric padding such as 8.8750 and preserves fractional basis points. Inactive surcharge/tip-stage rates do not block payment. Tax and surcharge failures are reported separately.
- Seating includes cleaning actions, preserves assignment state, refreshes rooms, and uses dirty-occupancy counts consistently. Optional preferences, add-ons, full rotation and tax details are collapsed in operational dialogs.

Validation:
- Web/API TypeScript checks and repository lint guards passed.
- 87 focused web tests passed (validation, checkout, room availability, inline payment, completion and tip settlement).
- 38 API integration tests passed (core service/payment loop, rooms, checkout timing).
- 3 AI summary tests and 5 encrypted-cache unit tests passed.
- Extended service-brief integration test passed, including content permissions and erasure clearing the encrypted cache.
- Synthetic request using staging AI configuration returned five languages and correctly preserved an oil allergy, right-knee avoidance and unspecified pressure.
- Browser scripts `check-frontdesk-modals.mjs` and `check-service-brief-summary.mjs` passed; synthetic screenshots/PDF are written to /tmp/gf-frontdesk-review.

Deploy the additive migration `20260912181312_health_summary_cache.sql` before the API. No existing questionnaire answers are rewritten.
