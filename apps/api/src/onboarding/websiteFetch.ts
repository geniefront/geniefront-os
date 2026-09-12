import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { WebsitePage } from '@gf/ai';
import { AppError, ERROR_CODES } from '@gf/contracts';

export function privateIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (family === 6) {
    // WHATWG canonicalization also converts dotted IPv4 tails to hextets.
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left = '', right] = canonical.split('::');
    const head = left ? left.split(':').map(x => parseInt(x, 16)) : [];
    const tail = right ? right.split(':').map(x => parseInt(x, 16)) : [];
    const words = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
    if (words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff) {
      return privateIp(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`);
    }
    // Unspecified, loopback, compatible IPv4, ULA, link-local and multicast.
    return words.slice(0, 6).every(x => x === 0)
      || (words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80
      || (words[0]! & 0xff00) === 0xff00;
  }
  if (family !== 4) return true;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
    || (a === 100 && b! >= 64 && b! <= 127) || a! >= 224;
}
async function validateUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'invalid_website_url' } }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'unsafe_website_url' } });
  }
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'private_website_address' } });
  }
  return url;
}

async function fetchHtml(raw: string): Promise<{ url: URL; html: string }> {
  let url = await validateUrl(raw);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'GenieFront-Onboarding/1.0', Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(12_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await validateUrl(new URL(res.headers.get('location')!, url).toString()); continue;
    }
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'website', status: res.status } });
    }
    if (Number(res.headers.get('content-length') ?? '0') > 1_500_000) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'website_page_too_large' } });
    }
    return { url, html: (await res.text()).slice(0, 1_500_000) };
  }
  throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'website', reason: 'too_many_redirects' } });
}

function visibleText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim().slice(0, 50_000);
}

export async function fetchWebsitePages(raw: string): Promise<WebsitePage[]> {
  const root = await fetchHtml(raw);
  const candidates: string[] = [];
  const linkRe = /href\s*=\s*["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(root.html)) !== null) {
    try {
      const url = new URL(match[1]!, root.url);
      if (url.origin === root.url.origin && /(service|menu|price|contact|about|team|staff|hour)/i.test(url.pathname)) candidates.push(url.toString());
    } catch { /* malformed link */ }
  }
  const urls = [root.url.toString(), ...new Set(candidates)].slice(0, 5);
  const pages: WebsitePage[] = [{ url: root.url.toString(), text: visibleText(root.html) }];
  for (const url of urls.slice(1)) {
    try { const page = await fetchHtml(url); pages.push({ url: page.url.toString(), text: visibleText(page.html) }); }
    catch { /* secondary page is optional */ }
  }
  return pages;
}
