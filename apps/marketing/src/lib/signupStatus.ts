export type PublicSignupStatus = 'confirmed' | 'pending' | 'invalid';

export interface SignupSessionLookup {
  status: PublicSignupStatus;
  plan?: 'essential' | 'growth';
}

export function readCheckoutSessionId(search: string): string | null {
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    .get('session_id');
  if (!raw) return null;
  const id = raw.trim();
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id) || id.length < 20 || id.length > 255) {
    return null;
  }
  return id;
}

export async function lookupSignupSession(
  sessionId: string,
): Promise<SignupSessionLookup> {
  const res = await fetch(
    `${__API_BASE__}/v1/public/signup-session?session_id=${encodeURIComponent(sessionId)}`,
  );
  if (res.status >= 500) {
    return { status: 'pending' };
  }
  if (!res.ok) {
    return { status: 'invalid' };
  }
  const body = await res.json() as { status?: unknown; plan?: unknown };
  if (body.status === 'confirmed' || body.status === 'pending' || body.status === 'invalid') {
    const plan = body.plan === 'essential' || body.plan === 'growth' ? body.plan : undefined;
    return plan ? { status: body.status, plan } : { status: body.status };
  }
  return { status: 'invalid' };
}
