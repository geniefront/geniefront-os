# 24 · Platform operator console (`apps/platform`)

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](qa/TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


Internal GenieFront ops. Not a customer app. Not a database admin.

## Operator identity

`platform_operators` is an explicit allow-list keyed by `users.id` (same as Supabase Auth).

Roles today: `super_admin` | `support`.

A customer owner/manager membership is **not** a platform role. Access is never email-hardcoded in the frontend.

Seed (test/dev only):

- `ops@maildrop.cc` — active `super_admin`
- `exops@maildrop.cc` — revoked `support`

Production operators are inserted as the migration role (postgres). `app_user` can only `SELECT` its own row.

## API

All routes under `/v1/platform/...` require:

1. Verified Supabase JWT (`req.user`)
2. Active `platform_operators` row (`gf_platform_operator_role()`)

Staff/PIN tokens are rejected.

Cross-tenant **reads** go through narrow `SECURITY DEFINER` functions in `sql/0074`. Each function:

- reads `app.user_id` (set by `withUser`)
- asserts the caller is an active operator **inside the database**
- returns a fixed JSON shape
- does not accept arbitrary SQL
- strips pin/token/secret keys from audit payloads

Cross-tenant **writes** do not use those functions. After operator authorization, the API sets `withTenant` to the **target** shop and runs a named command (`platform.review10Dlc`, `platform.updateSupportRequest`, `platform.addSupportNote`, `platform.updateStorefrontWork`). FORCE RLS stays on. `audit_log.actor_kind = 'platform'` and `actor_id = platform_operators.id`.

## Support Mode (deferred)

Write-capable “login as customer” is **not** implemented.

Why: customer writes go through the command bus with a membership context, subscription freeze, and membership-scoped permissions. Minting a fake membership, or letting an operator pick `X-Membership-Id` for a shop they do not belong to, would either:

- bypass tenant checks, or
- attribute paid-state / ticket writes to the wrong actor.

This batch ships a **read-only support view**: store detail, billing, people (no secrets), setup, plus audited workflow queues.

A later write Support Mode would need:

1. `platform_support_sessions` (operator_id, location_id, reason, expires_at, revoked_at)
2. Server-issued short-lived support token, not a customer JWT
3. Command bus actor_kind `platform` with operator id retained on every write
4. Banner in desk UI bound to that session
5. Explicit allow-list of commands (never `billing.changePlan` / `billing.buyAddon` / ledger adjustments)
6. Expiration enforced in `dispatch` before tenant writes
7. Dual audit: support session id + operator user id

Until that exists, operators help customers from `apps/platform` without impersonation.

## Forbidden

- set subscription active
- grant paid credits / edit ledger
- arbitrary SQL / table editor
- browser `service_role`
- unrestricted impersonation
- claiming TCR/Telnyx filing from 10DLC internal review
