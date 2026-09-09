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
  'req.body.manageToken',
  // 订阅码（sql/0120）。它是「捡到就能用」的凭证，和 manage token 同一档
  'req.body.code',
  'req.query.t',
] as const;
