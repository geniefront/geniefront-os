#!/usr/bin/env bash
# Issue a Cloudflare Origin CA certificate while keeping the private key local.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${ROOT}/.env.production}"
CERT_DIR="${ROOT}/deploy/certs"
CERT_FILE="${CERT_DIR}/origin.pem"
KEY_FILE="${CERT_DIR}/origin.key"
ID_FILE="${CERT_DIR}/origin.id"

[[ -f "$ENV_FILE" ]] || { echo "✗ 找不到环境文件：${ENV_FILE}"; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${CLOUDFLARE_API_TOKEN:?缺少 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ZONE_ID:?缺少 CLOUDFLARE_ZONE_ID}"

for command_name in curl jq openssl install mktemp; do
  command -v "$command_name" >/dev/null || { echo "✗ 缺少命令：${command_name}"; exit 1; }
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
tmp_key="${tmp_dir}/origin.key"
tmp_csr="${tmp_dir}/origin.csr"
tmp_response="${tmp_dir}/response.json"
tmp_cert="${tmp_dir}/origin.pem"
tmp_id="${tmp_dir}/origin.id"

openssl ecparam -name prime256v1 -genkey -noout -out "$tmp_key"
chmod 0600 "$tmp_key"
openssl req -new -sha256 -key "$tmp_key" -out "$tmp_csr" \
  -subj "/CN=geniefront.com" \
  -addext "subjectAltName=DNS:geniefront.com,DNS:*.geniefront.com"

payload="$(jq -n \
  --rawfile csr "$tmp_csr" \
  '{hostnames:["geniefront.com","*.geniefront.com"], request_type:"origin-ecc", requested_validity:5475, csr:$csr}')"

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$payload" \
  "https://api.cloudflare.com/client/v4/certificates" > "$tmp_response"

jq -e '.success == true and (.result.certificate | length > 0)' "$tmp_response" >/dev/null \
  || { jq '{success, errors}' "$tmp_response"; exit 1; }
jq -j '.result.certificate' "$tmp_response" > "$tmp_cert"

cert_pub="$(openssl x509 -in "$tmp_cert" -pubkey -noout | openssl pkey -pubin -outform DER | shasum -a 256)"
key_pub="$(openssl pkey -in "$tmp_key" -pubout -outform DER | shasum -a 256)"
[[ "$cert_pub" == "$key_pub" ]] || { echo "✗ Cloudflare 返回的证书与本地私钥不匹配"; exit 1; }
openssl x509 -in "$tmp_cert" -noout -checkhost geniefront.com >/dev/null
openssl x509 -in "$tmp_cert" -noout -checkhost staging.geniefront.com >/dev/null

install -d -m 0750 "$CERT_DIR"
install -m 0644 "$tmp_cert" "$CERT_FILE"
install -m 0600 "$tmp_key" "$KEY_FILE"
jq -r '.result.id' "$tmp_response" > "$tmp_id"
install -m 0600 "$tmp_id" "$ID_FILE"

echo "✓ 已签发并保存新的 Cloudflare Origin CA 证书"
jq -r '"  ID: \(.result.id)\n  域名: \(.result.hostnames | join(", "))\n  到期: \(.result.expires_on)"' "$tmp_response"
