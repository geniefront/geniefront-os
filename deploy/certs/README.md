# Origin 证书

`origin.pem` 是 Cloudflare Origin CA 证书（有效期至 2041-08-11），可以提交 —— 它是公开的证书，
而且只被 Cloudflare 信任，泄露也没法拿去冒充别人。

**`origin.key` 绝不进仓库。** 它在两台机器的 `/opt/geniefront/origin.key`（0600），
需要重新生成时：

```bash
openssl req -new -newkey rsa:2048 -nodes -keyout origin.key -out origin.csr \
  -subj "/CN=api.geniefront.com"
curl -X POST https://api.cloudflare.com/client/v4/certificates \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --arg csr "$(cat origin.csr)" \
       '{hostnames:["api.geniefront.com"],requested_validity:5475,request_type:"origin-rsa",csr:$csr}')"
```
