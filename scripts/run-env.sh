#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
shift || true

case "$TARGET" in
  local|staging|production) ;;
  *) echo "用法：bash scripts/run-env.sh <local|staging|production> <command...>"; exit 2 ;;
esac
[[ $# -gt 0 ]] || { echo "缺少要执行的命令"; exit 2; }

ENV_FILE="${ROOT}/.env.${TARGET}"
[[ -f "$ENV_FILE" ]] || { echo "缺少 ${ENV_FILE}；先复制对应的 .example"; exit 1; }
"${ROOT}/scripts/env-guard.sh" "$TARGET"

# 只接受标准 KEY=VALUE，不使用 source，避免值中的 shell 字符被执行。
while IFS='=' read -r key value; do
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
  value="${value%$'\r'}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  export "$key=$value"
done < "$ENV_FILE"

export GF_ENV_FILE="$ENV_FILE"
exec "$@"
