import { describe, it, expect, vi, afterEach } from 'vitest';
import { planForPriceId } from './stripe/client';
import { xaiDialXml } from './voice/texml';
afterEach(() => vi.unstubAllEnvs());
describe('voice provider policies', () => {
  it('maps the special price back to its own plan', () => {
    vi.stubEnv('STRIPE_PRICE_VOICE_BOOKING', 'price_voice');
    vi.stubEnv('STRIPE_PRICE_ESSENTIAL', 'price_basic');
    expect(planForPriceId('price_voice')).toBe('voice_booking');
    expect(planForPriceId('price_basic')).toBe('essential');
    expect(planForPriceId('unknown')).toBeNull();
  });
  it('sets a provider-side maximum and records both call legs', () => {
    const xml = xaiDialXml('+17579999968', 'voice.example.com:5060', 'https://api.example.com');
    expect(xml).toContain('timeLimit="600"');
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('<Sip>sip:+17579999968@voice.example.com:5060</Sip>');
    expect(() => xaiDialXml('+17579999968', 'host</Sip>', 'https://api.example.com')).toThrow();
  });
});
