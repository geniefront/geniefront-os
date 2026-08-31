#!/usr/bin/env bash
# Install one wildcard Cloudflare Origin CA certificate on a target environment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
HOST="${2:-}"
case "$TARGET" in
  staging) ENV_FILE="${ROOT}/.env.staging"; REMOTE_DIR=/opt/geniefront-staging ;;
  production) ENV_FILE="${ROOT}/.env.production"; REMOTE_DIR=/opt/geniefront ;;
  *) echo "用法：bash deploy/install-origin-cert.sh <staging|production> <ssh-host> [cert] [key]"; exit 2 ;;
esac
[[ -n "$HOST" ]] || { echo "缺少 SSH host"; exit 2; }

CERT="${3:-${ROOT}/deploy/certs/origin.pem}"
KEY="${4:-${ROOT}/deploy/certs/origin.key}"
[[ -s "$CERT" && -s "$KEY" ]] || { echo "✗ 找不到证书或私钥"; exit 1; }

cert_pub=$(openssl x509 -in "$CERT" -pubkey -noout | openssl pkey -pubin -outform DER | shasum -a 256)
key_pub=$(openssl pkey -in "$KEY" -pubout -outform DER | shasum -a 256)
[[ "$cert_pub" == "$key_pub" ]] || { echo "✗ 证书与私钥不匹配"; exit 1; }

for env_key in API_HOST DESK_HOST KIOSK_HOST PLATFORM_HOST MARKETING_HOST; do
  host_name=$(grep -E "^${env_key}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)
  [[ -n "$host_name" ]] || continue
  openssl x509 -in "$CERT" -noout -checkhost "$host_name" >/dev/null 2>&1 \
    || { echo "✗ 证书不覆盖 ${host_name}"; exit 1; }
done

scp -q "$CERT" "$HOST:/tmp/gf-origin.pem"
scp -q "$KEY" "$HOST:/tmp/gf-origin.key"
ssh "$HOST" "
  install -d -m 0750 '${REMOTE_DIR}'
  install -m 0644 /tmp/gf-origin.pem '${REMOTE_DIR}/origin.pem'
  install -m 0600 /tmp/gf-origin.key '${REMOTE_DIR}/origin.key'
  rm -f /tmp/gf-origin.pem /tmp/gf-origin.key
"
echo "✓ Origin CA 证书已安装到 ${HOST}:${REMOTE_DIR}"
