#!/usr/bin/env bash
# Regression: staging/production env-guard and staging bootstrap pin
# hosted booking to staging-book / book.geniefront.com.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0
pass() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }

need() { command -v "$1" >/dev/null || { echo "✗ missing $1"; exit 1; }; }
need mktemp
need grep

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

write_base() {
  local file="$1" gf_env="$2"
  cat > "$file" <<EOF
GF_ENV=${gf_env}
APP_JWT_SECRET=env-guard-test-secret-at-least-32-chars
SUPABASE_URL=https://exampleproject.supabase.co
SUPABASE_ANON_KEY=anon-test
DATABASE_URL=postgres://app_user:x@db.example.supabase.co:5432/postgres
MIGRATION_DATABASE_URL=postgres://postgres:x@db.example.supabase.co:5432/postgres
APP_DB_PASSWORD=test-db-password
APP_URL=https://staging-api.geniefront.com
VITE_API_BASE=https://staging-api.geniefront.com
APP_BASE_URL=https://staging-desk.geniefront.com
STRIPE_SECRET_KEY=sk_test_dummy
STRIPE_PUBLISHABLE_KEY=pk_test_dummy
STRIPE_WEBHOOK_SECRET=whsec_dummy
STRIPE_PRICE_ESSENTIAL=price_essential
STRIPE_PRICE_GROWTH=price_growth
FORM_ENCRYPTION_KEY=form-encryption-key-at-least-32-chars
MARKETING_BASE_URL=https://staging.geniefront.com
FORM_BASE_URL=https://staging-desk.geniefront.com
EOF
}

run_guard() {
  local target="$1" file="$2"
  GF_ENV_FILE="$file" GF_ENV_GUARD_SKIP_STRIPE=1 \
    bash "${ROOT}/scripts/env-guard.sh" "$target"
}

echo "env-guard / bootstrap staging-book origins"

# --- staging exact origins required ---
stg="${WORKDIR}/.env.staging"
write_base "$stg" staging
cat >> "$stg" <<'EOF'
BOOKING_HOST=staging-book.geniefront.com
BOOKING_PAGE_ORIGIN=https://staging-book.geniefront.com
VITE_BOOKING_ORIGIN=https://staging-book.geniefront.com
BOOKING_MANAGE_PAGE_ENABLED=
EOF
if run_guard staging "$stg" >/tmp/env-guard-ok.out 2>&1; then
  pass "staging accepts exact staging-book origins"
else
  bad "staging rejected a valid staging-book env"
  cat /tmp/env-guard-ok.out
fi

# stale desk origin must fail
stg_bad="${WORKDIR}/.env.staging-desk"
write_base "$stg_bad" staging
cat >> "$stg_bad" <<'EOF'
BOOKING_HOST=staging-desk.geniefront.com
BOOKING_PAGE_ORIGIN=https://staging-desk.geniefront.com
VITE_BOOKING_ORIGIN=https://staging-desk.geniefront.com
EOF
if run_guard staging "$stg_bad" >/tmp/env-guard-desk.out 2>&1; then
  bad "staging accepted staging-desk booking origins"
else
  grep -q 'BOOKING_HOST' /tmp/env-guard-desk.out \
    && pass "staging rejects staging-desk BOOKING_HOST" \
    || bad "staging failed but did not mention BOOKING_HOST"
fi

# missing VITE_BOOKING_ORIGIN must fail
stg_miss="${WORKDIR}/.env.staging-miss"
write_base "$stg_miss" staging
cat >> "$stg_miss" <<'EOF'
BOOKING_HOST=staging-book.geniefront.com
BOOKING_PAGE_ORIGIN=https://staging-book.geniefront.com
EOF
if run_guard staging "$stg_miss" >/tmp/env-guard-miss.out 2>&1; then
  bad "staging accepted missing VITE_BOOKING_ORIGIN"
else
  grep -q 'VITE_BOOKING_ORIGIN' /tmp/env-guard-miss.out \
    && pass "staging requires VITE_BOOKING_ORIGIN" \
    || bad "staging failed but did not mention VITE_BOOKING_ORIGIN"
fi

# --- production exact origins required ---
prd="${WORKDIR}/.env.production"
cat > "$prd" <<'EOF'
GF_ENV=production
APP_JWT_SECRET=env-guard-test-secret-at-least-32-chars
SUPABASE_URL=https://prodproject.supabase.co
SUPABASE_ANON_KEY=anon-test
DATABASE_URL=postgres://app_user:x@db.prod.supabase.co:5432/postgres
APP_URL=https://api.geniefront.com
VITE_API_BASE=https://api.geniefront.com
APP_BASE_URL=https://desk.geniefront.com
STRIPE_SECRET_KEY=sk_live_dummy
STRIPE_PUBLISHABLE_KEY=pk_live_dummy
STRIPE_WEBHOOK_SECRET=whsec_dummy
STRIPE_PRICE_ESSENTIAL=price_essential
STRIPE_PRICE_GROWTH=price_growth
FORM_ENCRYPTION_KEY=form-encryption-key-at-least-32-chars
MARKETING_BASE_URL=https://www.geniefront.com
FORM_BASE_URL=https://desk.geniefront.com
BOOKING_HOST=book.geniefront.com
BOOKING_PAGE_ORIGIN=https://book.geniefront.com
VITE_BOOKING_ORIGIN=https://book.geniefront.com
BOOKING_MANAGE_PAGE_ENABLED=
EOF
if run_guard production "$prd" >/tmp/env-guard-prod.out 2>&1; then
  pass "production accepts exact book.geniefront.com origins"
else
  bad "production rejected a valid book.geniefront.com env"
  cat /tmp/env-guard-prod.out
fi

prd_bad="${WORKDIR}/.env.production-bad"
sed 's|book.geniefront.com|staging-book.geniefront.com|g' "$prd" > "$prd_bad"
if run_guard production "$prd_bad" >/tmp/env-guard-prod-bad.out 2>&1; then
  bad "production accepted staging-book origins"
else
  grep -q 'BOOKING_HOST' /tmp/env-guard-prod-bad.out \
    && pass "production rejects non-book.geniefront.com BOOKING_HOST" \
    || bad "production failed but did not mention BOOKING_HOST"
fi

prd_miss="${WORKDIR}/.env.production-miss"
grep -v '^VITE_BOOKING_ORIGIN=' "$prd" > "$prd_miss"
if run_guard production "$prd_miss" >/tmp/env-guard-prod-miss.out 2>&1; then
  bad "production accepted missing VITE_BOOKING_ORIGIN"
else
  grep -q 'VITE_BOOKING_ORIGIN' /tmp/env-guard-prod-miss.out \
    && pass "production requires VITE_BOOKING_ORIGIN" \
    || bad "production failed but did not mention VITE_BOOKING_ORIGIN"
fi

# --- bootstrap generates staging-book, never staging-desk ---
src="${WORKDIR}/.env"
cat > "$src" <<'EOF'
APP_JWT_SECRET=env-guard-test-secret-at-least-32-chars
SUPABASE_URL=https://exampleproject.supabase.co
SUPABASE_ANON_KEY=anon-test
DATABASE_URL=postgres://app_user:x@db.example.supabase.co:5432/postgres
MIGRATION_DATABASE_URL=postgres://postgres:x@db.example.supabase.co:5432/postgres
APP_DB_PASSWORD=test-db-password
STRIPE_SECRET_KEY=sk_test_dummy
STRIPE_PUBLISHABLE_KEY=pk_test_dummy
STRIPE_WEBHOOK_SECRET=whsec_dummy
STRIPE_PRICE_ESSENTIAL=price_essential
STRIPE_PRICE_GROWTH=price_growth
FORM_ENCRYPTION_KEY=form-encryption-key-at-least-32-chars
EOF
generated="${WORKDIR}/generated.staging"
if ! GF_STAGING_ENV_SOURCE="$src" GF_STAGING_ENV_FILE="$generated" \
     GF_ENV_GUARD_SKIP_STRIPE=1 \
     bash "${ROOT}/scripts/bootstrap-staging-env.sh" >/tmp/bootstrap.out 2>&1; then
  bad "bootstrap-staging-env.sh failed"
  cat /tmp/bootstrap.out
else
  getg() { grep -E "^$1=" "$generated" | tail -1 | cut -d= -f2-; }
  [[ "$(getg BOOKING_HOST)" == staging-book.geniefront.com ]] \
    && pass "bootstrap writes BOOKING_HOST=staging-book.geniefront.com" \
    || bad "bootstrap BOOKING_HOST=$(getg BOOKING_HOST)"
  [[ "$(getg BOOKING_PAGE_ORIGIN)" == https://staging-book.geniefront.com ]] \
    && pass "bootstrap writes BOOKING_PAGE_ORIGIN=https://staging-book.geniefront.com" \
    || bad "bootstrap BOOKING_PAGE_ORIGIN=$(getg BOOKING_PAGE_ORIGIN)"
  [[ "$(getg VITE_BOOKING_ORIGIN)" == https://staging-book.geniefront.com ]] \
    && pass "bootstrap writes VITE_BOOKING_ORIGIN=https://staging-book.geniefront.com" \
    || bad "bootstrap VITE_BOOKING_ORIGIN=$(getg VITE_BOOKING_ORIGIN)"
  [[ "$(getg BOOKING_MANAGE_PAGE_ENABLED)" == "" ]] \
    && pass "bootstrap writes BOOKING_MANAGE_PAGE_ENABLED empty" \
    || bad "bootstrap BOOKING_MANAGE_PAGE_ENABLED=$(getg BOOKING_MANAGE_PAGE_ENABLED)"
  if grep -E '^(BOOKING_HOST|BOOKING_PAGE_ORIGIN|VITE_BOOKING_ORIGIN)=' "$generated" \
       | grep -q staging-desk; then
    bad "bootstrap booking keys still point at staging-desk"
  else
    pass "bootstrap booking keys do not use staging-desk"
  fi
fi

for origin in https://supabase.geniefront.com https://unapproved.example.com; do
  candidate="${WORKDIR}/.env.production-self-hosted"
  sed "s|^SUPABASE_URL=.*|SUPABASE_URL=${origin}|" "$prd" > "$candidate"
  if run_guard production "$candidate" >"${WORKDIR}/self-hosted.out" 2>&1; then
    [[ "$origin" == https://supabase.geniefront.com ]] \
      && pass "production accepts the approved self-hosted Supabase" \
      || bad "production accepted an unapproved Supabase origin"
  else
    [[ "$origin" == https://unapproved.example.com ]] \
      && grep -q 'Supabase' "${WORKDIR}/self-hosted.out" \
      && pass "production rejects unapproved Supabase origins" \
      || bad "production rejected the approved self-hosted Supabase"
  fi
done

if [[ $fail -ne 0 ]]; then
  echo "✗ env-guard / bootstrap staging-book regression"
  exit 1
fi
echo "✓ env-guard / bootstrap staging-book origins"
