import { describe, it, expect } from 'vitest';
import { normalizeLunaError, LunaRuntimeError, LunaRuntime } from './luna.js';

describe('Luna Runtime Error Classification (29 §5.1)', () => {
  it('identifies rate limits', () => {
    const err = normalizeLunaError({ status: 429, message: 'Rate limit exceeded' });
    expect(err).toBeInstanceOf(LunaRuntimeError);
    expect(err.kind).toBe('rate_limit_exceeded');
    expect(err.status).toBe(429);
  });

  it('identifies upstream timeouts', () => {
    const err = normalizeLunaError({ status: 504, message: 'Gateway Timeout' });
    expect(err.kind).toBe('upstream_timeout');
  });

  it('identifies timeout from connection abort or ETIMEDOUT', () => {
    const err = normalizeLunaError(new Error('Connection timed out: ETIMEDOUT'));
    expect(err.kind).toBe('upstream_timeout');
  });

  it('identifies context length exceeded', () => {
    const err = normalizeLunaError({ message: 'maximum context length is 128000 tokens' });
    expect(err.kind).toBe('context_length_exceeded');
  });

  it('identifies model refusal', () => {
    const err = normalizeLunaError({ message: 'Request violated model safety policy (refusal)' });
    expect(err.kind).toBe('refusal');
  });

  it('identifies cancellation', () => {
    const err = normalizeLunaError({ name: 'AbortError', message: 'The operation was aborted' });
    expect(err.kind).toBe('cancelled');
  });
});

 describe('Luna credentials', () => {
  it('rejects Anthropic credentials before creating an upstream client without exposing the key', () => {
    const key = 'sk-ant-test-secret';
    expect(() => new LunaRuntime(key)).toThrow('OpenAI runtime requires an OpenAI API key');
    try { new LunaRuntime(key); } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });
});
