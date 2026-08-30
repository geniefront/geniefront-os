import type { FastifyInstance } from 'fastify';
import { createSignupCheckout } from './checkout';

export function registerSignupCheckoutRoutes(app: FastifyInstance): void {
  app.post('/v1/public/signup-checkout', async (req) => {
    return createSignupCheckout(req.body, { ip: req.ip, log: req.log });
  });
}
