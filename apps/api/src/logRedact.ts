/**
 * Pino/Fastify paths that must never appear in application logs.
 * Manage tokens belong in the JSON body of `/public/v1/hosted/manage`,
 * never on the request line; this is belt-and-suspenders if a serializer
 * dumps `req.body`.
 */
export const LOGGER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-device-token"]',
  'req.headers["x-staff-token"]',
  'req.headers["x-gf-commerce-token"]',
  'req.body.recipientEmail',
  'req.body.recipientNote',
  'req.body.manageToken',
  // 订阅码（sql/0120）。它是「捡到就能用」的凭证，和 manage token 同一档
  'req.body.code',
  'req.body.input.payments[*].giftCardCode',
  'req.body.input.storedValuePayments[*].giftCardCode',
  'req.body.input.ticketSelections[*].storedValuePayments[*].giftCardCode',
  'req.query.t',
] as const;

/** Legacy gift-card lookup URLs remain supported, but their bearer credentials never reach request logs. */
export function redactRequestUrl(url:string):string {
  try {
    const parsed=new URL(url,'http://request-log.invalid');
    for(const key of [...parsed.searchParams.keys()])if(['code','token','t'].includes(key.toLowerCase()))parsed.searchParams.set(key,'[redacted]');
    return `${parsed.pathname}${parsed.search}`;
  } catch {return '[invalid-request-url]';}
}
