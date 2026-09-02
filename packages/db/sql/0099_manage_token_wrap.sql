-- ════════════════════════════════════════════════════════════════════════════
--  0099 · Envelope-encrypt the raw manage token for later notifications
--
--  Lookup stays digest-only (`manage_token_digest`). The raw token is random
--  and cannot be reconstructed from the digest, so later merchant-initiated
--  reschedule/cancel/reminder notifications cannot build `manage_url`.
--
--  This column stores AES-256-GCM ciphertext of the raw token. It is not an
--  authorization secret: validation still compares SHA-256 digests. Unwrap
--  happens only in the notification enqueue path (Task 8).
--
--  Rules:
--    · never log the raw token or this blob
--    · never write either into audit_log
--    · never mint a replacement token just to send a later notification
--    · appointments issued before wrap-at-issuance keep working links;
--      later notifications simply omit manage_url if unwrap is impossible
-- ════════════════════════════════════════════════════════════════════════════

alter table appointments
  add column if not exists manage_token_wrapped bytea;

comment on column appointments.manage_token_wrapped is
  'AES-256-GCM wrap of the raw manage token for later transactional notifications. Not used for authorization. Digest remains the lookup key.';
