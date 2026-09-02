import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { LOGGER_REDACT_PATHS } from './logRedact';

describe('application log redaction', () => {
  it('keeps raw manage tokens out of captured application logs', async () => {
    expect(LOGGER_REDACT_PATHS).toContain('req.body.manageToken');
    expect(LOGGER_REDACT_PATHS).toContain('req.query.t');

    const lines: string[] = [];
    const app = Fastify({
      logger: {
        stream: { write(s: string) { lines.push(s); } },
        redact: { paths: [...LOGGER_REDACT_PATHS], censor: '[redacted]' },
      },
    });
    await app.ready();
    app.log.info({
      req: {
        url: '/public/v1/hosted/manage',
        headers: { authorization: 'Bearer secret' },
        body: { slug: 'lotus-nails', manageToken: 'mt_should_never_appear' },
        query: { t: 'mt_query_token' },
      },
    }, 'incoming request');
    await app.close();

    const captured = lines.join('\n');
    expect(captured).not.toContain('mt_should_never_appear');
    expect(captured).not.toContain('mt_query_token');
    expect(captured).not.toContain('Bearer secret');
    expect(captured).toContain('/public/v1/hosted/manage');
    expect(captured).not.toMatch(/\/l\/[^"\s]+\/g\/mt_/);
  });
});
