/**
 * P2-8: copilot summary generate must persist through the command bus.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBusinessSummary } from '@gf/ai';
import { withTenant, closeDb } from '@gf/db';
import type { Locale } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { generateAndSaveBusinessSummary } from './businessSummary';
import { buildServer } from './server';
import { issueStaffSession, STAFF_TOKEN_HEADER } from './auth/staffSession';
import { dispatchSystem } from './test/systemDispatch';

vi.mock('@gf/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gf/ai')>();
  return {
    ...actual,
    generateBusinessSummary: vi.fn(),
  };
});

const generateBusinessSummaryMock = vi.mocked(generateBusinessSummary);

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const nailTenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };
const spaTenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

const here = dirname(fileURLToPath(import.meta.url));

const generated = {
  content: {
    highlights: ['Service revenue held steady this month.'],
    risks: ['Returning-guest share is thinning.'],
    actions: ['Call sleeping VIP clients this week.'],
  },
  model: 'claude-sonnet-5',
};

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let staffToken: string;
let app: Awaited<ReturnType<typeof buildServer>>;
let previousApiKey: string | undefined;

function noReportCtx(locale: Locale = 'en') {
  const permissions = new Set([...ownerCtx.permissions]);
  permissions.delete('report.view');
  return { ...ownerCtx, permissions, locale };
}

function ctxAt(locale: Locale) {
  return { ...ownerCtx, locale };
}

async function countSummaries(locationId: string, orgId: string): Promise<number> {
  const rows = await withTenant({ orgId, locationId, membershipId: null }, (tx) =>
    tx<{ n: number }[]>`select count(*)::int as n from ai_business_summaries where location_id = ${locationId}`);
  return rows[0]!.n;
}

async function setStatus(orgId: string, locationId: string, status: string) {
  await withTenant({ orgId, locationId, membershipId: null }, (tx) => tx`
    insert into billing_accounts (org_id, location_id, plan, subscription_status)
    values (${orgId}, ${locationId}, 'essential', ${status})
    on conflict (location_id) do update set subscription_status = excluded.subscription_status`);
}

beforeAll(async () => {
  previousApiKey = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = 'test-openai-key';

  const [owner] = await withTenant(nailTenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ownerCtx = await buildContext({ userId: owner!.user_id, membershipId: owner!.id });

  const session = await issueStaffSession(
    { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: owner!.id },
    'claim_code',
    'test_device',
  );
  staffToken = session.token;
  app = buildServer();
});

afterAll(async () => {
  if (previousApiKey === undefined) delete process.env['OPENAI_API_KEY'];
  else process.env['OPENAI_API_KEY'] = previousApiKey;
  await setStatus(NAIL_ORG, NAIL_LOC, 'active');
  await closeDb();
});

beforeEach(async () => {
  generateBusinessSummaryMock.mockReset();
  generateBusinessSummaryMock.mockResolvedValue(generated);
  await setStatus(NAIL_ORG, NAIL_LOC, 'active');
});

describe('analytics copilot summary generate (P2-8)', () => {
  it('persists through dispatch(), not a route-level insert', async () => {
    const before = await countSummaries(NAIL_LOC, NAIL_ORG);
    const result = await generateAndSaveBusinessSummary(ctxAt('ko'), 'test-key');
    expect(result.highlights[0]).toMatch(/Service revenue/);
    expect(result.generatedAt).toBeTruthy();
    expect(await countSummaries(NAIL_LOC, NAIL_ORG)).toBe(before + 1);
    expect(generateBusinessSummaryMock).toHaveBeenCalledOnce();

    const audits = await withTenant(nailTenant, (tx) => tx<{ command: string }[]>`
      select command from audit_log
      where location_id = ${NAIL_LOC} and command = 'analytics.saveBusinessSummary'`);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]!.command).toBe('analytics.saveBusinessSummary');

    const src = readFileSync(resolve(here, 'businessSummary.ts'), 'utf8');
    const routeSrc = readFileSync(resolve(here, 'routes/analytics.ts'), 'utf8');
    expect(src).not.toMatch(/insert into ai_business_summaries/);
    expect(src).toMatch(/dispatch[\s\S]*'analytics\.saveBusinessSummary'/);
    expect(routeSrc).not.toMatch(/insert into ai_business_summaries/);
    expect(routeSrc).toMatch(/generateAndSaveBusinessSummary/);
  });

  it('requires report.view', async () => {
    const before = await countSummaries(NAIL_LOC, NAIL_ORG);
    await expect(generateAndSaveBusinessSummary(noReportCtx('zh-Hant'), 'test-key'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(generateBusinessSummaryMock).not.toHaveBeenCalled();
    expect(await countSummaries(NAIL_LOC, NAIL_ORG)).toBe(before);

    await expect(dispatchSystem('analytics.saveBusinessSummary', {
      periodStart: '2026-08-01',
      periodEnd: '2026-08-30',
      generator: 'anthropic',
      generatorVersion: 'claude-sonnet-5',
      inputFactsSha256: 'a'.repeat(64),
      inputRecordCount: 1,
      content: generated.content,
    }, noReportCtx())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('tenant A cannot write tenant B summary', async () => {
    const spaBefore = await countSummaries(SPA_LOC, SPA_ORG);
    await generateAndSaveBusinessSummary(ctxAt('vi'), 'test-key');
    expect(await countSummaries(SPA_LOC, SPA_ORG)).toBe(spaBefore);

    const { result } = await dispatchSystem<{ summaryId: string }>(
      'analytics.saveBusinessSummary',
      {
        periodStart: '2026-08-01',
        periodEnd: '2026-08-30',
        generator: 'anthropic',
        generatorVersion: 'claude-sonnet-5',
        inputFactsSha256: 'b'.repeat(64),
        inputRecordCount: 1,
        content: generated.content,
      },
      ownerCtx,
    );
    const leaked = await withTenant(spaTenant, (tx) => tx<{ id: string }[]>`
      select id from ai_business_summaries where id = ${result.summaryId}`);
    expect(leaked).toHaveLength(0);
  });

  it('past_due and canceled freeze generate-and-persist, but reads still work', async () => {
    for (const status of ['past_due', 'canceled'] as const) {
      await setStatus(NAIL_ORG, NAIL_LOC, status);
      generateBusinessSummaryMock.mockClear();
      const before = await countSummaries(NAIL_LOC, NAIL_ORG);
      const locale = status === 'past_due' ? 'es' : 'zh-Hans';

      await expect(generateAndSaveBusinessSummary(ctxAt(locale), 'test-key'))
        .rejects.toMatchObject({ code: 'SUBSCRIPTION_PAST_DUE' });
      expect(generateBusinessSummaryMock).not.toHaveBeenCalled();
      expect(await countSummaries(NAIL_LOC, NAIL_ORG)).toBe(before);

      await expect(dispatchSystem('analytics.saveBusinessSummary', {
        periodStart: '2026-08-01',
        periodEnd: '2026-08-30',
        generator: 'anthropic',
        generatorVersion: 'claude-sonnet-5',
        inputFactsSha256: (status === 'past_due' ? 'c' : 'd').repeat(64),
        inputRecordCount: 1,
        content: generated.content,
      }, ownerCtx)).rejects.toMatchObject({ code: 'SUBSCRIPTION_PAST_DUE' });

      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/desk/analytics/copilot-summary',
        headers: { [STAFF_TOKEN_HEADER]: staffToken },
      });
      expect(getRes.statusCode).toBe(200);
    }
    await setStatus(NAIL_ORG, NAIL_LOC, 'active');
  });

  it('calls the model outside the DB transaction', async () => {
    const { withTenant: originalWithTenant } = await import('@gf/db');
    const db = await import('@gf/db');
    let depth = 0;
    const spy = vi.spyOn(db, 'withTenant').mockImplementation(async (ctx, fn) => {
      depth += 1;
      try {
        return await originalWithTenant(ctx, fn);
      } finally {
        depth -= 1;
      }
    });
    generateBusinessSummaryMock.mockImplementation(async () => {
      expect(depth).toBe(0);
      return generated;
    });
    try {
      await generateAndSaveBusinessSummary(ctxAt('en'), 'test-key');
      expect(generateBusinessSummaryMock).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('AI failure writes nothing', async () => {
    const before = await countSummaries(NAIL_LOC, NAIL_ORG);
    const auditsBefore = await withTenant(nailTenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where location_id = ${NAIL_LOC} and command = 'analytics.saveBusinessSummary'`);
    generateBusinessSummaryMock.mockRejectedValue(new Error('anthropic_down'));
    await expect(generateAndSaveBusinessSummary(ctxAt('zh-Hant'), 'test-key')).rejects.toThrow('anthropic_down');
    expect(await countSummaries(NAIL_LOC, NAIL_ORG)).toBe(before);
    const audits = await withTenant(nailTenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where location_id = ${NAIL_LOC} and command = 'analytics.saveBusinessSummary'`);
    expect(audits[0]!.n).toBe(auditsBefore[0]!.n);
  });

  it('command validation failure after AI does not persist or report success', async () => {
    const before = await countSummaries(NAIL_LOC, NAIL_ORG);
    generateBusinessSummaryMock.mockResolvedValue({
      ...generated,
      model: 'x'.repeat(80),
    });
    await expect(generateAndSaveBusinessSummary(ctxAt('zh-Hant'), 'test-key'))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await countSummaries(NAIL_LOC, NAIL_ORG)).toBe(before);
  });

  it('POST /v1/desk/analytics/copilot-summary/generate uses the same path', async () => {
    const before = await countSummaries(NAIL_LOC, NAIL_ORG);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/desk/analytics/copilot-summary/generate',
      headers: { [STAFF_TOKEN_HEADER]: staffToken },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().highlights[0]).toMatch(/Service revenue/);
    expect(await countSummaries(NAIL_LOC, NAIL_ORG)).toBeGreaterThanOrEqual(before);
  });
});
