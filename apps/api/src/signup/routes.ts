import type { FastifyInstance } from 'fastify';
import { createSignupCheckout } from './checkout';
import { lookupSignupSession } from './sessionStatus';

export function registerSignupCheckoutRoutes(app: FastifyInstance): void {
  app.post('/v1/public/signup-checkout', async (req) => {
    return createSignupCheckout(req.body, {
      ip: req.ip,
      // 结账页语言由此决定，并沿用为店主账单邮件的默认语言
      acceptLanguage: req.headers['accept-language'],
      log: req.log,
    });
  });

  /**
   * Marketing success page confirmation. session_id comes from Stripe's
   * success_url placeholder; this is a coarse lookup, not a generic
   * Checkout Session inspector.
   */
  app.get('/v1/public/signup-session', async (req) => {
    const sessionId = (req.query as { session_id?: unknown }).session_id;
    return lookupSignupSession(sessionId, { ip: req.ip, log: req.log });
  });
}
