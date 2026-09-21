# Zhi Zi Massage production voice binding

Cut over on 2026-09-20 at the user's request. The production shop is `va-zhi-zi-massage` (location `1c708a61-b467-4062-af96-2cd6392e20e5`).

- Inbound voice number: **+1 757 731 7358**.
- xAI agent: `agent_IgbIjsohua8ketED`, named **Zhi Zi Massage · Production** and published.
- Existing tool credential follows this agent; the former staging phone binding is inactive. Secrets remain in ignored private configuration, never this document.
- All three API tools (`get_store_context`, `submit_booking`, `manage_my_appointment`) use `https://api.geniefront.com/v1/voice/%2B17577317358/` with their existing paths and parameter definitions.
- Voice: **Iris**, speaking speed **1.1×**. Published greeting: “Thank you for calling Zhi Zi Massage. How can I help you today?” The recording announcement was removed at the owner’s request; recording remains enabled.
- Provisioning defaults for future agents: Iris, 1.1×, concise store greeting without the recording announcement. xAI agents are currently provisioned manually; apply these defaults in the provider console.
- Store transfer number: **+1 667 660 6667**. Notification targets use the production owner and store contact.
- Telnyx TeXML application: **3053337047696672309**, named `Zhi Zi Massage Production 600s`.
- Telnyx number resource: `3047677534805165608`, bound to that TeXML application.
- Inbound webhook: `https://api.geniefront.com/v1/telnyx/xai/inbound` (POST).
- The application restores the original two inbound channels and outbound voice profile. Its generated Dial instructions enforce 600 seconds and dual-channel recording; the production recording callback is `/v1/telnyx/xai/recording`.
- The former production demo-store phone binding and staging test-store phone binding are inactive. Test bookings and history were not copied into production.

The inbound number changed from +1 757 999 9968 to +1 757 731 7358 on 2026-09-20 at 19:30:09 UTC. The former production binding is inactive; its historical calls remain intact. The new xAI SIP number uses the Telnyx allowed-address preset. All three production tools were repointed to the new number and the agent was published. New-number context returns 200 with eight services; the old-number route returns 401. The existing Telnyx TeXML application continues to enforce recording and the 600-second limit. This configuration change has not yet been verified by a live PSTN call.

The prior TeXML application was deleted externally during cutover and the number was moved to the `xai-test` direct SIP connection. The user explicitly chose to restore the original TeXML flow against production; the new application above replaces the deleted one.

Recording imports must have a provider start time at or after the active phone binding's creation/activation time. Older or undated recordings are skipped, preventing a new store from receiving or being billed for the previous binding's history.

Verified: production context returns Zhi Zi Massage and its eight bookable primary service variants; the old staging credential route returns 401; management requests missing system caller metadata return 403; provider phone/application reads confirm the production webhook and number association. No live PSTN call or real test booking was placed during cutover.

See [caller-scoped management](voice-management-v2.md) for security and policy behavior. The earlier [V1 staging setup](voice-booking-v1.md) is historical.

## Conversation display and call emails

Recording processing now preserves speaker turns and second offsets. Dual-channel Telnyx recordings use caller channel 0 and dialed-agent channel 1. Malformed multichannel word timing triggers one diarized retry; classification maps actual speaker IDs to caller/receptionist, leaving uncertain identities unassigned. Text without speaker information is never labelled as a customer utterance.

The calls API returns the stored summary. Both call and appointment details render the same conversation component. Call emails use the shared brand layout, verified caller/time/duration, a summary, a short dialogue preview, and an authenticated `/calls?call=<id>` link. The single-call API enforces tenant and appointment-read access even for older calls. Emails already delivered are not resent by transcript repairs.

The existing Zhi Zi call `97f8d8db-0ff0-4345-b415-aed7d4b7d0dc` was repaired into eight reviewed turns without changing its original wording or billing. A private pre-change backup was retained. Tests cover speaker ordering/fallback, safe email rendering, tenant-scoped reads, preserved summaries/turns, and once-only billing.

## Seven-day booking context (2026-09-21)

The V2 rollout uses `GET /context-v2`, `POST /bookings-v2`, and `POST /appointments-v2/{action}` under the existing store-scoped voice prefix. Legacy endpoints remain compatible. The initial context request includes the same provider System headers as management (`x-gf-caller-number`, `x-gf-call-start-time`); neither is a model-generated argument.

The initial response includes today's local date plus six days of basic service availability, menu/addons, eligible staff, and caller-scoped upcoming appointments. Consecutive times are represented as inclusive `HH:mm-HH:mm/step` ranges. Each date/selection has a short `slotToken`; booking adds `time: HH:mm`. Initial offers use catalog `serviceKey` aliases and the catalog price to avoid repeating UUIDs and prices across seven days. The seven-day calculation uses seven batched scheduling reads shared across dates/services; writes always recheck fresh state. Server-side references retain the actual offered instants and expire after 15 minutes. They are shared across API nodes, tenant isolated, and invalidated by tool credential rotation. The response stays within the provider's observed 16 KiB limit; `coverage.complete=false` explicitly requires targeted lookups for missing selections.

Use `date` and `itemsJson` for exact combinations. Items contain `guestIndex`, `serviceId`, `addonIds`, and optional requested `staffId`; `guestIndices` supports shared services. The shared party planner handles consecutive services for one guest, simultaneous starts for different guests, addons, skills, staff and resources. The atomic booking handler rechecks availability and quoted price under the booking lock. Automatic assignment is not a customer request. Repeating the same selection/contact/time recovers a committed result without creating another booking.

The managed-agent console currently exposes no pre-call context injection hook. Initialization therefore uses one silent `get_store_context` call at the first opportunity, rather than claiming that context is injected before the greeting. A future direct SIP/WebSocket orchestration change would be needed for a guaranteed pre-greeting dynamic injection. Do not confuse an unverified caller or failed lookup with an empty appointment list.

Canonical instructions: [production prompt](xai-voice-production-prompt.md). Existing appointment management supports whole-booking reschedule/cancel with addons preserved. Partial cancellation and changing existing services or staff route to human assistance; do not cancel/recreate a booking as a workaround.

Conversation rollout settings: Iris at 1.0×, silence follow-up after 10 seconds (two reminders before idle hangup), concise greeting “Zhi Zi Massage, how can I help?”. These replace the original 1.1× / five-second settings above.

Both API nodes run a background snapshot worker at startup and every five seconds. Store-only seven-day snapshots refresh every minute; catalog, staff, resource, shift and appointment changes mark them due after two seconds. A database lease prevents duplicate work across nodes, and revision checks retain invalidation when data changes during calculation. Calls read the last usable snapshot immediately while refresh happens in the background (maximum age five minutes, same local calendar date and credential scope). Responses report snapshot age and staleness; failed refreshes preserve the previous result and retry after 30 seconds. The signed Telnyx inbound handler also starts prewarming without delaying routing. Caller appointments are queried in parallel using the actual call's system identity and never enter this shared cache. Targeted availability searches and booking writes always bypass the initial snapshot cache. Cold recovery uses the same lease and batched calculation.

### SIP transport incident (2026-09-21)

The 18:09:23 and 18:09:56 UTC inbound callbacks returned valid TeXML (HTTP 200 in about 60 ms). Telnyx answered the caller, then the xAI SIP leg timed out before answer with SIP 408 after approximately three seconds. The returned SIP URI omitted `;transport=tls`, whereas the agent console explicitly supplies that transport. The successful 14:35 UTC call also used the old URI, so the logs alone do not establish why the path started failing. Dial generation now explicitly requests TLS, matching the console. API/WebSocket health alone is not evidence that PSTN/SIP calls work; verify a live inbound call after this change.


Follow-up: Telnyx's TLS retry at 18:17:39 UTC still targeted port 5060. Its source was `192.76.120.10`, already inside the saved xAI allowlist; the xAI API corroborated both existing CIDRs. A certificate-verified TLS probe timed out on 5060 but succeeded with TLS 1.3 on `sip.voice.x.ai:5061`. Runtime and saved production/staging configuration now use `XAI_SIP_HOST=sip.voice.x.ai:5061`; no allowlist expansion was made. Deployment environment validation rejects the known-invalid TLS/5060 combination. Live PSTN confirmation is still required; a successful TLS handshake alone does not establish call completion.

Recovery confirmed: after both production nodes switched to `sip.voice.x.ai:5061`, the owner redialed the production number and confirmed that the AI answered. The allowlist stayed unchanged throughout this recovery. The environment guard was also tested with an otherwise-valid production configuration pointing to 5060 and rejected it.

### Background snapshot rollout — 2026-09-21

Runtime `b3ea7ee-20260921184358` deployed to both production nodes after staging, with the snapshot migration applied to both databases. Startup and subsequent refreshes were observed on different nodes, confirming shared lease handoff. Three external context requests returned HTTP 200 in 657–800 ms with all 63 seven-day offers (~11.9 KB); API processing was 320–403 ms. A response during the refresh boundary returned immediately with `coverage.stale=true`, and the next snapshot advanced `generatedAt` and returned `stale=false`. Production background builds still took 5.4–6.5 seconds; they no longer block ordinary context requests. A saved-agent read-only xAI session called `get_store_context` and answered the shop hours successfully. Both nodes retained `sip.voice.x.ai:5061`. Validation: 142 affected tests, API typecheck, architecture guards and local database security advisors passed. No production booking was created or modified by verification.

### Complete call history and appointment activity

Every verified completed recording is now inserted into `phone_calls` when queued, before transcription/classification. Failed processing leaves a playable recording visible with pending/review billing. Migration backfills missing recordings and retries the two known speaker-label format failures with delayed owner notifications suppressed. Numeric speaker labels are normalized; optional invalid labels no longer discard otherwise valid billing analysis.

Explicit appointment lookups and attempted changes produce tenant-scoped `voice_appointment_activity` records using authenticated caller/start-time headers. Successful cancellation/rescheduling marks the activity complete in the same transaction as the booking change. The recording worker associates activity only with a unique same-caller recording window. Ambiguous windows remain unlinked. Initial automatic context lookup does not label every call an appointment inquiry. Existing creation associations remain intact, and appointment details show all linked calls for every booking source; the call list distinguishes requests from completed changes. Historical modification calls without saved identity/activity cannot be safely reconstructed from transcript guesses.

Business segments include appointment inquiries, changes and cancellation whether or not successful. Existing exclusions for spam, unsolicited sales, unrelated conversation, silence and observable system failures remain. Metering is per call, rounded once; several appointment links do not multiply usage. Pending/review recordings display pending minutes until validated analysis settles them. Audio/transcript access retains contact permissions and tenant isolation.

### Price confirmation and conversational handoff — 2026-09-21

Reviewed three recent production booking conversations, including the repeated couples-selection failure. The published prompt now keeps morning/evening/exact-time preferences, offers at most two relevant alternatives, skips unsolicited email questions, states the full group total before booking, waits for price agreement, and asks whether anything else is needed before waiting for the caller's goodbye. The end-call tool description independently requires this final response, except when the caller has already said goodbye.

`submit_booking` now requires model-generated Boolean `priceConfirmed` and Number `confirmedTotalCents` body parameters in the saved xAI tool. Its description defines agreement as accepting the exact service/duration/time/party total, not merely answering a contact question. The API rejects missing/false consent or mismatched totals before dispatch; existing quote-versus-current-price validation still applies. No code can independently prove spoken consent from a model-supplied flag, so actual call transcripts remain the evidence for conversational compliance.

Shared guest arrays can supply their anchor implicitly. Simple couples selections become one service per pair. Repeated shared services covering the same guests fail both availability and write-time validation, including old stored references. Detailed field errors support one informed correction instead of a guessing loop. The saved `get_store_context` tool documents the complete one-item couples shape.

Validation: 37 affected tests passed; API typecheck and architecture guards passed. Production runtime `ff47a68-20260921191443` is healthy on both nodes. The xAI agent was published and its instructions verified after reload. Production checks confirmed one couples selection returns $120, duplicate selections fail, and unconfirmed/wrong-price submissions fail; no test appointment was created. The pre-existing incorrect booking was left unchanged at the user's explicit request.

Production verification: both nodes deployed `4501be5-20260921191029`; front desk shows all eight recordings. Both recovered jobs completed with exactly one usage event each and zero delayed SMS/email. One historical cancellation association was recovered from a successful `voice-cancel:` idempotency result and a unique matching caller/recording window, with an audit entry. Other historical actions lacking comparable evidence remain unlinked. The initial context still returned all 63 offers in 861 ms externally. Validation: 146 API tests plus four frontend and four metering tests passed. A legacy phone test expecting two assigned staff IDs also fails on unchanged main; no scheduling behavior was changed here.

An additional billing boundary check excludes short assistant-only opening greetings, even if the model classifies them as business. Unknown/customer speech and actual booking inquiries do not match this exception. The recovered five-second greeting-only call was identified for a one-minute quota correction; the 27-second cancellation remains billable. Eighteen focused API/provider tests and API typecheck passed for this follow-up.

A live-version console text preview (no booking authorization) quoted the couples total as $120, answered the closing-time question, asked whether anything else was needed, waited for the reply, and called the end-call tool only after the explicit goodbye. No appointment was submitted. A final prompt refinement makes price-only inquiries direct answers without unnecessary price-acceptance/contact questions; it was published afterward. The preview was ended and closed.

Follow-up runtime `41fb2c3-20260921191939` is healthy on both production nodes after staging. The greeting-only correction was applied transactionally with an audit entry: the existing usage event retains original quantity metadata, its net quantity is zero, and one included minute was restored. The 27-second cancellation retains one billable minute and one usage event. Browser verification showed eight calls, the recovered cancellation label/link, two recordings under the same appointment (creation and cancellation), and a successfully loaded audio player. SIP remains `sip.voice.x.ai:5061` on both nodes. Historical recovery produced no SMS/email notifications.

### Spoken-style prompt simplification — 2026-09-21

Reviewed conversation `ecff387c-28cf-41fa-bd10-319cafff604f`: business tools succeeded, but the assistant read catalog labels, expanded an unambiguous date, announced an all-day slot range, repeated noon, and read an already-accepted calling number aloud. Rewrote the production prompt around short conversational turns and one concise price agreement. Ordinary service names, relative dates and "noon" replace catalog/date narration; group bookings need one contact; related questions may be combined naturally. The duplicate-couples, price-consent, tenant/caller identity, retry and wait-before-hangup rules remain. The source and console draft were compared exactly, then published to the live agent. This was a prompt-only update; speech settings, backend code and existing appointments were not changed. Actual voice delivery remains to be evaluated on subsequent calls.
