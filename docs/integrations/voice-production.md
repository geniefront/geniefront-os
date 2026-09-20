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
