import { describe, expect, it } from 'vitest';
import { readCheckoutSessionId } from './signupStatus';

describe('readCheckoutSessionId', () => {
  it('accepts Stripe Checkout session ids', () => {
    expect(readCheckoutSessionId('?session_id=cs_test_gfsuccesslookupabc123'))
      .toBe('cs_test_gfsuccesslookupabc123');
  });

  it('rejects missing or malformed ids', () => {
    expect(readCheckoutSessionId('')).toBeNull();
    expect(readCheckoutSessionId('?session_id=not-a-session')).toBeNull();
    expect(readCheckoutSessionId('?session_id=cs_test_short')).toBeNull();
    expect(readCheckoutSessionId('?other=cs_test_gf_success_lookup_abc123')).toBeNull();
  });
});
