# Zhi Zi call review and production repair — 2026-09-29 EDT

The three unsuccessful booking inquiries requested starts within the existing 30-minute advance-notice window. The owner's approved policy is now a five-minute lead time and a ten-minute slot grid, scoped to `va-zhi-zi-massage`; the existing 30-day horizon is preserved. This store uses the shared online-booking rules for voice and public availability. Existing appointments are unchanged.

## Repairs

- `settings.saveVoiceBookingRules` accepts an optional slot interval and preserves it when older clients omit it. `scripts/zhizi-call-repair.ts` applies the approved store settings through the audited command bus using the existing restricted runtime DB role, then refreshes its voice snapshot.
- `context-v2` accepts optional local `time`. Targeted responses now distinguish `requestedTime.available` from successful HTTP/lookup status, give an explicit `too_soon` reason where applicable, and return at most two actual nearest alternatives. The booking write still rejects times absent from the stored offer.
- The published xAI context tool has an optional generated query parameter `time`; its description and agent instructions require checking exact availability before confirming a time. The existing temporary no-transfer and service-boundary policies were preserved from the live prompt and synchronized into the tracked prompt. No transfer tool was enabled.
- Telnyx supplied the anonymous caller as `null` in its CDR and `Anonymous` in its recording metadata. Passing null to optional-string `call.record.fromE164` aborted CDR reconciliation and prevented the next recording stage from running. The importer now omits unknown numbers, matches explicit withheld-caller markers only within the corroborated unique session/connection/destination/window, continues past individual failures, and runs the two reconciliation stages independently.
- Generic call labels no longer claim that inquiries were resolved. Calls without a booked appointment display “Call ended · no booking”; assistant-only short openings retain their separate label.

## Validation and production result

- 63 focused tests passed: 53 API integration tests against a new disposable local PostgreSQL container, six exact-time/reconciliation unit tests, and four contract tests. API/Web typechecks, architecture guards, production Web build, and API Docker build passed.
- Both `gf-a` and `gf-b` run API image `geniefront/api:zhizi-313329b-1790735879044`, following a staging deployment. Health returned 200 and unauthenticated `/v1/me/locations` returned 401 on each node.
- The API release is commit `313329b` plus the already-deployed Maileroo implementation. All 13 preserved Maileroo source files were compared byte-for-byte with the running image's source map before building. Unrelated dirty working-tree changes were not included. Remote runtime environment files, self-hosted Supabase connection, and mail configuration were preserved. Future full releases must also retain that existing Maileroo implementation until its independent changes are committed.
- The desk was built with the current production Supabase public configuration and deployed to both nodes, preserving old hashed assets. The desk entry-point cache was purged.
- Production offers for September 30 return `09:00-21:00/10`: 09:10 is available; 09:15 is not, with 09:10/09:20 alternatives. Published-agent console checks gave those same answers. No test booking was created. These are console checks, not a new PSTN call.
- All six September 29 inbound calls to the store number now have recording IDs, transcript turns, summaries, and completed processing jobs. The anonymous call and three evening transcripts were recovered by the worker. The 19:44 call succeeded on retry after one invalid classification interval response; metering validation was not weakened. Old-call notifications remain suppressed by the existing reconciliation policy.

The deployment manifest, source hashes and local inspection artifacts are in the task worktree's untracked `artifacts/zhizi-call-repair/` directory. The original dirty checkout remains untouched.
