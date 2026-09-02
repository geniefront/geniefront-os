# Messaging Templates Implementation Plan

> Inline execution in this session. Spec: docs/27 + option B (copy + layout + unsubscribe page).

**Goal:** Every outbound email uses one HTML shell; default copy is rewritten; marketing unsubscribe link opens a working public page.

**Architecture:** Shared `email/layout.ts` wraps path A (hardcoded) and path B (DB templates). GET unsubscribe becomes peek-only; POST remains the action. Public `/unsubscribe` lives on the web SPA outside the login gate.

**Tech Stack:** Fastify, Postgres seed SQL, Vite React web, vitest.

## Global Constraints

- Customer email/SMS: English only. No CJK in customer templates.
- SMS: GSM-7, prefer 1 segment (160). No "reply CANCEL". Sender `GenieFront`.
- Shop-editable templates stay escaped (never interpret as HTML).
- Owner billing emails: bilingual via `organizations.default_locale`. No card details.
- Do not wire dead events (`appointment_confirm` path B, `staff_pending_confirm`, `staff_assigned`).
- Customized shop templates (body != old default) are not overwritten.

---

### Task 1: Shared email layout + path A rewrite
### Task 2: Marketing HTML wrap in dispatch
### Task 3: SQL default copy (0086 + 0093 refresh of unmodified rows)
### Task 4: GET/POST unsubscribe split + tests
### Task 5: Public Unsubscribe page + SessionGate bypass
### Task 6: Docs 27 status
