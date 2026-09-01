/**
 * AWS Signature Version 4 请求签名。
 *
 * 本模块不依赖 `@aws-sdk/*`。SES v2 的调用面在本系统内仅涉及「发送邮件」与
 * 「邮件身份管理」两类接口，均为普通的 JSON over HTTPS；为此引入 AWS SDK 会
 * 带来数十个传递依赖，与本仓库既有的外部服务接入方式（Telnyx、
 * Cloudflare 均为直接 HTTP 调用）不一致，且显著增加构建体积与供应链面积。
 *
 * ⚠️ 签名算法的每一个细节都会影响结果，且失败表现统一为
 * `403 SignatureDoesNotMatch`，无法从错误信息反推出错环节。以下几处为实现中
 * 最易出错的约束，修改前请先阅读：
 *
 *   · 规范请求（canonical request）中的头部名必须小写、按字典序排列，
 *     且头部值需折叠内部连续空白；
 *   · `SignedHeaders` 必须与规范请求中列出的头部完全一致，且实际发出的请求
 *     必须包含全部这些头部；
 *   · 路径中的每一段需按 RFC 3986 编码，但 `/` 本身不编码；
 *   · 载荷哈希取的是**最终发送的字节序列**，因此签名必须在序列化之后进行。
 *
 * 参考：AWS 文档 “Signature Version 4 signing process”。
 */

import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** 仅在使用临时凭据（STS / 实例角色）时存在。 */
  sessionToken?: string | undefined;
}

export interface SignableRequest {
  method: string;
  /** 绝对路径，以 `/` 开头，未编码。查询串请放入 `query`。 */
  path: string;
  query?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  /** 请求体的最终字节序列。GET 等无体请求传空串。 */
  body?: string | undefined;
  service: string;
  region: string;
  host: string;
  /** 签名时刻。仅测试需要显式指定，生产环境留空取当前时间。 */
  now?: Date | undefined;
}

/**
 * RFC 3986 编码。
 *
 * ⚠️ `encodeURIComponent` 不编码 `!'()*` 四个字符，而 AWS 的规范要求编码。
 * 遗漏时对不含这些字符的请求无影响，因此该缺陷不会在常规用例中暴露。
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 路径逐段编码，用于**实际发出的请求行**。`/` 为分隔符，不参与编码。
 */
export function encodePath(path: string): string {
  if (!path || path === '/') return '/';
  return path.split('/').map(rfc3986).join('/');
}

/**
 * 规范请求中的路径。
 *
 * ⚠️ **除 S3 外的所有 AWS 服务，规范路径要求对每个路径段编码两次。**
 * 也就是说，实际请求行里的 `awsses%40geniefront.com` 在参与签名时应写作
 * `awsses%2540geniefront.com`。
 *
 * 该规则在路径段不含需转义字符时是恒等变换，因此纯域名路径
 * （`/v2/email/identities/mail.geniefront.com`）无论是否遵守都能通过 ——
 * 缺陷只在引入含 `@`、空格等字符的路径参数时暴露，且表现为
 * `InvalidSignatureException`，与凭据错误无法区分。
 */
export function canonicalPath(path: string): string {
  if (!path || path === '/') return '/';
  return encodePath(path).split('/').map(rfc3986).join('/');
}

/** 查询串按参数名字典序排列后编码。 */
export function canonicalQuery(query: Record<string, string> | undefined): string {
  if (!query) return '';
  return Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k] ?? '')}`)
    .join('&');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** `YYYYMMDDTHHMMSSZ`。AWS 要求的基本格式，不含分隔符。 */
export function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
}

/**
 * 派生签名密钥。四层 HMAC 依次绑定日期、区域、服务与算法版本，
 * 使得同一份长期凭据派生出的密钥在时空上均受限。
 */
function signingKey(
  secretAccessKey: string, dateStamp: string, region: string, service: string,
): Buffer {
  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

/**
 * 计算请求所需的全部签名头部。
 *
 * 返回值为**需要附加到请求上的头部集合**，已包含调用方传入的 `headers`
 * 以及本函数补齐的 `host` / `x-amz-date` / `authorization`。调用方应直接使用
 * 返回值作为最终头部，不要与原 `headers` 再次合并 —— 任何在签名之后新增或
 * 修改的、位于 `SignedHeaders` 之列的头部都会导致验签失败。
 */
export function signRequest(
  req: SignableRequest, creds: AwsCredentials,
): Record<string, string> {
  const now = req.now ?? new Date();
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const body = req.body ?? '';

  const headers: Record<string, string> = {
    ...(req.headers ?? {}),
    host: req.host,
    'x-amz-date': stamp,
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  /*
   * ⚠️ 头部名小写、按字典序排列；头部值去除首尾空白并折叠内部连续空白。
   * 该规范化必须与 AWS 服务端的实现完全一致，否则签名不匹配。
   */
  const normalized = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const signedHeaders = normalized.map(([k]) => k).join(';');
  const canonicalHeaders = normalized.map(([k, v]) => `${k}:${v}\n`).join('');

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalPath(req.path),
    canonicalQuery(req.query),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join('\n');

  const scope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM, stamp, scope, sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac(
    'sha256', signingKey(creds.secretAccessKey, dateStamp, req.region, req.service),
  ).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * 从环境变量读取凭据。
 *
 * 返回 `null` 而非抛出异常：调用方需要区分「未配置」（应静默跳过，见
 * `email/send.ts` 的 `emailConfigured()`）与「配置错误」（应报错），
 * 而在此处抛出会使两者难以区分。
 */
export function credentialsFromEnv(env = process.env): AwsCredentials | null {
  const accessKeyId = env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = env['AWS_SECRET_ACCESS_KEY'];
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    ...(env['AWS_SESSION_TOKEN'] ? { sessionToken: env['AWS_SESSION_TOKEN'] } : {}),
  };
}

/** SES 所在区域。未配置时取 `us-east-1`（门店与顾客均位于美东）。 */
export function awsRegion(env = process.env): string {
  return env['AWS_REGION'] ?? 'us-east-1';
}
