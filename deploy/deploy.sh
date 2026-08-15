#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  部署到 VPS。滚动更新：先 A，健康了再 B，任何一台没起来就中止。
#
#  用法：  bash deploy/deploy.sh            # 两台都部
#          bash deploy/deploy.sh gf-a       # 只部一台
#
#  暂时没有镜像仓库，用 docker save | ssh docker load 直接推。
#  等有 CI 了换成 registry —— 现在为一个镜像架私服不值当。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOSTS=("${@:-gf-a gf-b}")
[[ $# -gt 0 ]] && HOSTS=("$@") || HOSTS=(gf-a gf-b)
TAG="$(git rev-parse --short HEAD)"
IMAGE="geniefront/api:${TAG}"
REMOTE_DIR=/opt/geniefront

G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
log() { echo "${D}▸${N} $*"; }

# ── 1. 生产 .env：从本地 .env 里【剔除】不该上服务器的东西 ────────────────────
#
# 宪法第 5 条：service_role 只有 packages/db 的迁移脚本能读，生产只进 CI Secret。
# 迁移连接串同理 —— 应用运行时用的是受限角色 app_user。
# 与其指望人记得，不如在这里显式列黑名单。
DENY='^(SUPABASE_SERVICE_ROLE_KEY|MIGRATION_DATABASE_URL|APP_DB_PASSWORD|DEEPSEEK_.*|VPS_.*)='

PROD_ENV="$(mktemp)"
trap 'rm -f "$PROD_ENV"' EXIT
grep -E '^[A-Z][A-Z0-9_]*=' .env | grep -vE "$DENY" > "$PROD_ENV"
sed -i '' 's|^NODE_ENV=.*|NODE_ENV=production|; s|^APP_URL=.*|APP_URL=https://api.geniefront.com|; s|^LOG_LEVEL=.*|LOG_LEVEL=info|' "$PROD_ENV" 2>/dev/null \
  || sed -i 's|^NODE_ENV=.*|NODE_ENV=production|; s|^APP_URL=.*|APP_URL=https://api.geniefront.com|; s|^LOG_LEVEL=.*|LOG_LEVEL=info|' "$PROD_ENV"

# 防呆：黑名单漏了就别部署
if grep -qE "$DENY" "$PROD_ENV"; then
  echo "${R}✗ 生产 .env 里仍有敏感项，中止${N}"; exit 1
fi
log "生产 .env：$(wc -l < "$PROD_ENV" | tr -d ' ') 项（已剔除 service_role / 迁移连接串）"

# ── 2. 构建 ─────────────────────────────────────────────────────────────────
log "构建 ${IMAGE}（linux/amd64）"
# ⚠️ 必须显式指定平台：开发机可能是 Apple Silicon(arm64)，而 VPS 是 amd64。
# 不指定的话镜像能 load 进去、容器能创建，但一 exec 就是 "exec format error"。
# --provenance=false：否则产出的是 manifest list，docker save 出来的包
# 在目标机上会挑不到正确的架构。
docker build -q --platform linux/amd64 --provenance=false \
  -f deploy/Dockerfile -t "$IMAGE" -t geniefront/api:latest . >/dev/null
SIZE=$(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.0fMB", $1/1048576}')
log "镜像 ${SIZE}"

# ── 3. 逐台推送并启动 ────────────────────────────────────────────────────────
for h in "${HOSTS[@]}"; do
  echo
  echo "═══ ${h} ═══"

  log "推送镜像"
  docker save "$IMAGE" | gzip -1 | ssh "$h" 'gunzip | docker load' | tail -1

  log "同步配置"
  scp -q "$PROD_ENV" "$h:/tmp/gf.env"
  scp -q deploy/compose.yml deploy/Caddyfile "$h:/tmp/"
  ssh "$h" "
    install -m 0600 /tmp/gf.env ${REMOTE_DIR}/.env
    install -m 0644 /tmp/compose.yml ${REMOTE_DIR}/compose.yml
    install -m 0644 /tmp/Caddyfile   ${REMOTE_DIR}/Caddyfile
    rm -f /tmp/gf.env /tmp/compose.yml /tmp/Caddyfile
  "

  log "启动"
  # 只起 api：Caddy 要等 DNS 指过来才能签证书，那是单独一步
  ssh "$h" "cd ${REMOTE_DIR} && TAG=${TAG} docker compose up -d --no-deps api"

  log "等健康检查"
  ok=0
  for i in $(seq 1 30); do
    sleep 2
    if ssh "$h" 'curl -sf --max-time 3 http://127.0.0.1:3000/health' >/dev/null 2>&1; then ok=1; break; fi
  done
  if [[ $ok -eq 1 ]]; then
    echo "  ${G}✓ ${h} 健康${N}"
  else
    echo "  ${R}✗ ${h} 起不来，中止部署（后面的机器保持旧版本）${N}"
    ssh "$h" "cd ${REMOTE_DIR} && docker compose logs --tail=30 api"
    exit 1
  fi
done

echo
echo "${G}部署完成${N}  版本 ${TAG}"
