/**
 * Guest manage tokens live in the URL fragment (`#g/{token}`) so they are
 * never sent to Caddy or Cloudflare. The older `/l/:slug/g/:token` path is
 * still accepted client-side as a fallback and is never issued.
 */
export function manageTokenFromHash(hash: string): string {
  const m = /^#(?:\/)?g\/([^/?#]+)$/.exec(hash);
  if (!m?.[1]) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function hostedManagePath(slug: string, token: string): string {
  return `/l/${encodeURIComponent(slug)}#g/${encodeURIComponent(token)}`;
}
