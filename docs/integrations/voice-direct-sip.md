# Direct SIP voice operations

Production Zhi Zi Massage uses Telnyx FQDN connection `3053359378305386217` to `sip.voice.x.ai:5061` over TLS. Number `+17577317358` is resource `3047677534805165608`; its xAI agent is `agent_IgbIjsohua8ketED`. The owner verified both AI answering and transfer to staff on 2026-09-22. There is no application-enforced 600-second call cutoff. Do not restore the TeXML bridge to implement recording, metering or notifications.

## Routing and admission

`XAI_DIRECT_SIP_ROUTES` is an explicit JSON array of `{number, numberId, connectionId}`. Unlisted numbers are untouched. A separate worker reconciles each listed number every 30 seconds and on startup, independently of transcription jobs. It verifies the provider number against the configured E.164 and uses tenant-scoped reads for the active AI binding, staff fallback, shop status and voice quota.

When AI is available, the number uses its configured direct connection, no unconditional forwarding, and dual-channel MP3 inbound recording. When AI is disabled, the shop is closed/suspended, or its subscription/quota blocks AI, subsequent calls forward to the active staff number and inbound recording is disabled. With no valid staff fallback, the number is detached instead of continuing to answer through AI; reenabling restores the configured connection. Synchronization affects future calls, does not terminate an ongoing call, and is eventually consistent (normally within 30 seconds plus provider latency). Provider failures are logged and retried without falling back to TeXML.

Do not set a call-control webhook on the SIP connection: Telnyx documents that doing so changes calls from SIP trunking to programmable routing. The existing xAI booking/context/appointment tools retain their credentials, caller identity headers, fresh availability checks and notification behavior. Caller metadata remains valid for calls up to 24 hours old; the separate 15-minute offer/appointment references still expire and must be refreshed.

## Recordings, history, notifications and billing

The recording worker scans paginated Telnyx recordings and SIP detail records over the preceding 24 hours. Completed direct calls enter history even if audio is missing. Missed calls and provider-confirmed unconditional forwarding settle at zero AI usage. An AI call without audio remains pending rather than inventing a transcript or charge.

Direct recording jobs require a matching provider session, connection, inbound leg, caller and called number. CDRs must be complete and at least 90 seconds past the inbound call's finish time. The earliest outbound transfer leg marks the end of AI time; the original recording can contain the subsequent staff conversation, but that portion never consumes AI minutes. A direct-to-staff forwarded call has zero AI seconds. Missing or ambiguous evidence is retried rather than treated as an all-AI call. The provider boundary is stored in the internal job payload and billing analysis, never accepted from the model. Classification still excludes spam, silence and system failures; remaining business seconds are rounded once per call. Existing job leases, usage settlement, and outbox uniqueness prevent duplicate billing and notifications across both API nodes.

Recording processing restores playback, speaker turns, summaries, booking/activity links and existing configured email/SMS notifications. Notifications can arrive after CDR settlement and transcription. Historical calls made while recording was disabled cannot have audio reconstructed; their call history can still be recovered without charging unverified AI usage.

Provider references: [number voice settings](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/phone-numbers/voice.ts), [SIP connection settings](https://support.telnyx.com/en/articles/4351104-sip-connection-settings), [external transfers](https://developers.telnyx.com/docs/voice/sip-trunking/features/external-transfers).
