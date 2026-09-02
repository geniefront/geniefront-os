#!/usr/bin/env bash
# Explicit, guarded deployment for staging or production.
#
#   pnpm deploy:staging
#   GF_CONFIRM_PRODUCTION=deploy-production pnpm deploy:production
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-}"
shift || true
case "$TARGET" in
  staging)
    ENV_FILE=".env.staging"
    REMOTE_DIR="/opt/geniefront-staging"
    DEFAULT_HOSTS=(gf-staging)
    VITE_MODE=staging
    ;;
  production)
    ENV_FILE=".env.production"
    REMOTE_DIR="/opt/geniefront"
    DEFAULT_HOSTS=(gf-a gf-b)
    VITE_MODE=production
    [[ "${GF_CONFIRM_PRODUCTION:-}" == deploy-production ]] || {
      echo "✗ 生产部署需要显式确认：GF_CONFIRM_PRODUCTION=deploy-production pnpm deploy:production"
      exit 1
    }
    ;;
  *)
    echo "用法：bash deploy/deploy.sh <staging|production> [ssh-host ...]"
    exit 2
    ;;
esac

"${ROOT}/scripts/env-guard.sh" "$TARGET"
HOSTS=("${DEFAULT_HOSTS[@]}")
[[ $# -gt 0 ]] && HOSTS=("$@")

get() {
  local key="$1" value
  value=$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
  value="${value%$'\r'}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

API_HOST="$(get API_HOST)"
DESK_HOST="$(get DESK_HOST)"
KIOSK_HOST="$(get KIOSK_HOST)"
PLATFORM_HOST="$(get PLATFORM_HOST)"
MARKETING_HOST="$(get MARKETING_HOST)"
MARKETING_WWW_HOST="$(get MARKETING_WWW_HOST)"
BOOKING_HOST="$(get BOOKING_HOST)"

if [[ "$TARGET" == production ]]; then
  API_HOST=${API_HOST:-api.geniefront.com}
  DESK_HOST=${DESK_HOST:-desk.geniefront.com}
  KIOSK_HOST=${KIOSK_HOST:-kiosk.geniefront.com}
  PLATFORM_HOST=${PLATFORM_HOST:-ops.geniefront.com}
  MARKETING_HOST=${MARKETING_HOST:-geniefront.com}
  MARKETING_WWW_HOST=${MARKETING_WWW_HOST:-www.geniefront.com}
  BOOKING_HOST=${BOOKING_HOST:-book.geniefront.com}
fi

for item in API_HOST DESK_HOST KIOSK_HOST PLATFORM_HOST MARKETING_HOST MARKETING_WWW_HOST BOOKING_HOST; do
  [[ -n "${!item}" ]] || { echo "✗ ${item} 未配置"; exit 1; }
done

COMMIT="$(git rev-parse --short HEAD)"
TAG="${GF_IMAGE_TAG:-${COMMIT}-$(date -u +%Y%m%d%H%M%S)}"
IMAGE="geniefront/api:${TAG}"

G=$'\033[32m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
log() { echo "${D}▸${N} $*"; }

# Runtime containers never receive migration credentials, service-role keys, or VPS credentials.
DENY='^(SUPABASE_SERVICE_ROLE_KEY|MIGRATION_DATABASE_URL|APP_DB_PASSWORD|TEST_.*|DATABASE_TEST_TARGET|GF_QA_.*|CLOUDFLARE_.*|VPS_.*|DEEPSEEK_.*)='
RUNTIME_ENV="$(mktemp)"
trap 'rm -f "$RUNTIME_ENV"' EXIT
grep -E '^[A-Z][A-Z0-9_]*=' "$ENV_FILE" | grep -vE "$DENY" > "$RUNTIME_ENV"

# These public routing values are authoritative for both Compose and Caddy.
for key in GF_ENV NODE_ENV API_HOST DESK_HOST KIOSK_HOST PLATFORM_HOST MARKETING_HOST MARKETING_WWW_HOST BOOKING_HOST; do
  sed -i '' "/^${key}=/d" "$RUNTIME_ENV" 2>/dev/null || sed -i "/^${key}=/d" "$RUNTIME_ENV"
done
{
  echo "GF_ENV=${TARGET}"
  echo 'NODE_ENV=production'
  echo "API_HOST=${API_HOST}"
  echo "DESK_HOST=${DESK_HOST}"
  echo "KIOSK_HOST=${KIOSK_HOST}"
  echo "PLATFORM_HOST=${PLATFORM_HOST}"
  echo "MARKETING_HOST=${MARKETING_HOST}"
  echo "MARKETING_WWW_HOST=${MARKETING_WWW_HOST}"
  echo "BOOKING_HOST=${BOOKING_HOST}"
} >> "$RUNTIME_ENV"

if grep -qE "$DENY" "$RUNTIME_ENV"; then
  echo "${R}✗ 运行时环境仍包含禁止项，中止${N}"
  exit 1
fi

log "构建 ${TARGET} 前端"
pnpm --filter @gf/web exec vite build --mode "$VITE_MODE" >/dev/null
pnpm --filter @gf/ipad exec vite build --mode "$VITE_MODE" >/dev/null
pnpm --filter @gf/marketing exec vite build --mode "$VITE_MODE" >/dev/null
pnpm --filter @gf/platform exec vite build --mode "$VITE_MODE" >/dev/null
pnpm --filter @gf/booking exec vite build --mode "$VITE_MODE" >/dev/null

log "构建 ${IMAGE}（linux/amd64）"
docker build -q --platform linux/amd64 --provenance=false \
  -f deploy/Dockerfile -t "$IMAGE" . >/dev/null

for host in "${HOSTS[@]}"; do
  echo
  echo "═══ ${TARGET} · ${host} ═══"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" true

  log "推送 API 镜像"
  docker save "$IMAGE" | gzip -1 | ssh "$host" 'gunzip | docker load' | tail -1

  log "同步配置与前端"
  scp -q "$RUNTIME_ENV" "$host:/tmp/gf-runtime.env"
  scp -q deploy/compose.yml deploy/Caddyfile "$host:/tmp/"
  ssh "$host" "mkdir -p '${REMOTE_DIR}/web' '${REMOTE_DIR}/kiosk' '${REMOTE_DIR}/platform' '${REMOTE_DIR}/marketing' '${REMOTE_DIR}/booking'"

  # 哈希资源先上传，index.html 最后覆盖；旧资源暂时保留，避免滚动期间 404。
  for app in web ipad platform marketing booking; do
    case "$app" in
      ipad) remote_app=kiosk ;;
      *) remote_app="$app" ;;
    esac
    COPYFILE_DISABLE=1 tar --no-xattrs --exclude='./index.html' -czf - -C "apps/${app}/dist" . | \
      ssh "$host" "tar -xzf - -C '${REMOTE_DIR}/${remote_app}'"
    scp -q "apps/${app}/dist/index.html" "$host:${REMOTE_DIR}/${remote_app}/index.html"
  done

  ssh "$host" "
    install -m 0600 /tmp/gf-runtime.env '${REMOTE_DIR}/.env'
    install -m 0644 /tmp/compose.yml '${REMOTE_DIR}/compose.yml'
    install -m 0644 /tmp/Caddyfile '${REMOTE_DIR}/Caddyfile'
    rm -f /tmp/gf-runtime.env /tmp/compose.yml /tmp/Caddyfile
    test -s '${REMOTE_DIR}/origin.pem'
    test -s '${REMOTE_DIR}/origin.key'
    for name in '${API_HOST}' '${DESK_HOST}' '${KIOSK_HOST}' '${PLATFORM_HOST}' '${MARKETING_HOST}' '${BOOKING_HOST}'; do
      openssl x509 -in '${REMOTE_DIR}/origin.pem' -noout -checkhost \"\$name\" >/dev/null
    done
    cd '${REMOTE_DIR}'
    RUNTIME_ENV_FILE=.env TAG='${TAG}' docker compose --env-file .env config -q
    RUNTIME_ENV_FILE=.env TAG='${TAG}' docker compose --env-file .env up -d
  "

  log "等待健康检查"
  healthy=0
  for _ in $(seq 1 30); do
    sleep 2
    if ssh "$host" 'curl -sf --max-time 3 http://127.0.0.1:3000/health' >/dev/null 2>&1; then
      healthy=1
      break
    fi
  done
  if [[ $healthy -ne 1 ]]; then
    echo "${R}✗ ${host} 未通过健康检查${N}"
    ssh "$host" "cd '${REMOTE_DIR}' && RUNTIME_ENV_FILE=.env docker compose --env-file .env logs --tail=40 api"
    exit 1
  fi
  echo "  ${G}✓ ${host} 健康${N}"
done

echo
echo "${G}${TARGET} 部署完成${N}  版本 ${TAG}"
