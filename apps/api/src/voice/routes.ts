import {registerVoiceManagementRoutes} from './manage';
import {registerVoiceV2Routes} from './v2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, ERROR_CODES, VoiceBookingInput, type CommandContext } from '@gf/contracts';
import { tenantForPhoneNumber, withTenant } from '@gf/db';
import { hashToolToken, sameDigest } from '../telnyx/toolToken';
import { loadVoiceContext } from './context';
import { assertAiAdmission } from '../billing/aiAdmission';
import { dispatch } from '../bus';
import { checkRateLimits } from '../public/rateLimit';
import { flushSms } from '../sms/flush';
import { flushEmails } from '../email/flush';
import '../handlers/voiceBooking';

const searchSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  serviceId: z.string().uuid().optional(), membershipId: z.string().uuid().optional(),
  partySize: z.coerce.number().int().min(1).max(10).default(1) }).strict();
const submitSchema = z.object({ providerCallId:z.string().min(1).max(200).optional(), slotToken: z.string().min(20).max(3000), customerName: z.string().trim().min(1).max(120),
  phoneE164: VoiceBookingInput.shape.phoneE164, email: z.string().email().optional(), notes: z.string().max(1000).optional() }).strict();
const signedSchema = z.object({ serviceId: z.string().uuid(), date: z.string(), startsAt: z.string(),
  membershipId: z.string().uuid().nullable(), membershipIds: z.array(z.string().uuid().nullable()).optional(), requestedMembershipId: z.string().uuid().optional(), partySize: z.number().int().min(1).max(10), expiresAt: z.number(), locationId: z.string().uuid() }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { issues: p.error.issues } });
  return p.data;
}
const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function registerVoiceRoutes(app: FastifyInstance) {
  async function authenticate(req: FastifyRequest) {
    const phone = (req.params as { number: string }).number;
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
    const verdict = await checkRateLimits([{ scope: 'voice-tools-ip', id: req.ip, limit: 120, windowSec: 60 }], app.log);
    if (!verdict.ok) throw new AppError(ERROR_CODES.AI_RATE_LIMITED);
    const t = await tenantForPhoneNumber(phone);
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!t?.toolTokenDigest || !token || !sameDigest(hashToolToken(token), t.toolTokenDigest)) {
      throw new AppError(ERROR_CODES.UNAUTHENTICATED);
    }
    if (!t.aiAnswer) throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { reason: 'voice_disabled' } });
    const ctx: CommandContext = { orgId: t.orgId, locationId: t.locationId, membershipId: null,
      userId: '00000000-0000-4000-8000-000000000000', actorKind: 'api', timezone: t.timezone,
      locale: 'en', permissions: new Set(['appointment.write', 'call.draft']) };
    await assertAiAdmission(ctx, 'voice_minute');
    return { ctx, secret: t.toolTokenDigest };
  }
  const lookupAppointments = registerVoiceManagementRoutes(app,authenticate);
  registerVoiceV2Routes(app, authenticate, lookupAppointments);
  app.get('/v1/voice/:number/context', async (req, reply) => {
    const { ctx, secret } = await authenticate(req);
    const search = parse(searchSchema, req.query);
    const context = await withTenant(ctx, tx => loadVoiceContext(tx, ctx.locationId, search));
    reply.header('Cache-Control', 'no-store');
    return { ...context, slots: context.slots.map(s => {
      const data = Buffer.from(JSON.stringify({ ...s, serviceId: search.serviceId, date: context.date,
        requestedMembershipId: search.membershipId, partySize: search.partySize, locationId: ctx.locationId, expiresAt: Date.now() + 15 * 60_000 })).toString('base64url');
      return { ...s, slotToken: `${data}.${sign(data, secret)}` };
    }) };
  });
  app.post('/v1/voice/:number/bookings', async (req, reply) => {
    const { ctx, secret } = await authenticate(req);
    const body = parse(submitSchema, req.body);
    const [data, sig, extra] = body.slotToken.split('.');
    const expected = data ? sign(data, secret) : '';
    if (!data || !sig || extra || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'invalid_slot_token' } });
    }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw new AppError(ERROR_CODES.VALIDATION_FAILED); }
    const slot = parse(signedSchema, raw);
    if (slot.locationId !== ctx.locationId || slot.expiresAt < Date.now()) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'slot_expired_query_again' } });
    }
    const { locationId: _, expiresAt: __, membershipIds: _assigned, requestedMembershipId, ...selected } = slot;
    const selection = { ...selected, membershipId: requestedMembershipId ?? (slot.membershipIds ? null : slot.membershipId) };
    const { slotToken: ___, ...customer } = body;
    // A refreshed offer for the same customer/time still replays the same booking.
    const id = createHash('sha256').update(JSON.stringify([ctx.locationId, slot.serviceId, slot.startsAt,
      slot.membershipId, slot.partySize, customer.phoneE164, customer.customerName.toLowerCase()])).digest('hex');
    const result = await dispatch('voice.submitBooking', { ...selection, ...customer }, ctx,
      { idempotencyKey: `voice-book-${id}`, systemOrigin: 'xai_voice' });
    void flushSms(ctx, app.log).catch(() => app.log.warn('Voice SMS flush will retry'));
    void flushEmails(ctx, app.log).catch(() => app.log.warn('Voice email flush will retry'));
    reply.header('Cache-Control', 'no-store');
    return { ok: true, ...result.result as object, replayed: result.replayed };
  });
}
