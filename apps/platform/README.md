# GenieFront operator console

Internal ops app. Not a customer product.

- Auth: Supabase session **plus** an active `platform_operators` row.
- Store owners who guess this URL are denied by `/v1/platform/session`.
- Paid subscription / credit truth remains Stripe-only. This app cannot set a shop active or grant credits.

Dev: `pnpm dev:platform` (port 5179). API must be running.
