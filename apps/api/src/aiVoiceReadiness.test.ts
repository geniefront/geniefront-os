/**
 * S4 · AI 电话线就绪五态推导（T06）。
 *
 * 每一态都从**持久化证据**推出来，不落状态列。这里逐态构造
 * `phone_lines` + `locations.settings.features`，断言 `loadAiVoiceReadiness`
 * 和向导 readiness 的一致读数；跑完把种子门店还原。
 *
 * 用足疗店（SPA）而不是美甲店：本文件是唯一改它 phone_lines 的套件，
 * 和 phone.test.ts（改 NAIL）互不干扰。
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import { buildContext } from './actor';
import { loadAiVoiceReadiness } from './queries/aiVoiceReadiness';
import { loadSetupReadiness } from './queries/setupReadiness';

const SPA = {
  orgId: '22222222-2222-4222-8222-222222222222',
  locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  membershipId: null as string | null,
};

let ctx: Awaited<ReturnType<typeof buildContext>>;

/** 把 SPA 的 ai_voice 线与功能位设成某个具体形态。 */
async function shape(opts: {
  intent?: boolean | null;
  line?: 'none' | 'active' | 'inactive';
  toolToken?: boolean;
  assistantId?: boolean;
  aiAnswer?: boolean;
}): Promise<void> {
  const {
    intent = false, line = 'active', toolToken = true,
    assistantId = false, aiAnswer = false,
  } = opts;
  await withTenant(SPA, async (tx) => {
    if (intent === null) {
      await tx`update locations
        set settings = settings #- '{features,ai_voice_requested}'
        where id = ${SPA.locationId}`;
    } else {
      await tx`update locations
        set settings = jsonb_set(settings, '{features,ai_voice_requested}', ${String(intent)}::jsonb, true)
        where id = ${SPA.locationId}`;
    }
    await tx`delete from phone_lines
      where location_id = ${SPA.locationId} and purpose = 'ai_voice'`;
    if (line !== 'none') {
      await tx`insert into phone_lines
        (org_id, location_id, e164, purpose, active, tool_token_digest, assistant_id, ai_answer)
        values (${SPA.orgId}, ${SPA.locationId}, '+13235550123', 'ai_voice',
          ${line === 'active'},
          ${toolToken ? 'a'.repeat(64) : null},
          ${assistantId ? 'assistant-xyz' : null},
          ${aiAnswer})`;
    }
  });
}

beforeAll(async () => {
  const [m] = await withTenant(SPA, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${SPA.locationId} and m.status = 'active'
      and r.key in ('owner','manager') limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
});

afterEach(async () => {
  // 还原成种子形态：active 线 + token、无 assistant_id、ai_answer=false、intent=false
  await shape({ intent: false, line: 'active', toolToken: true });
});

afterAll(async () => {
  await closeDb();
});

const read = () => withTenant(SPA, (tx) => loadAiVoiceReadiness(tx, ctx));

describe('AI 电话就绪五态', () => {
  it('unconfigured —— 没意愿、没绑线', async () => {
    await shape({ intent: false, line: 'none' });
    const r = await read();
    expect(r).toMatchObject({
      state: 'unconfigured', intent: false, lineBound: false,
      ready: false, effectiveAiAnswer: false,
    });
  });

  it('requested —— 勾了意愿但落地号 / token 还没就绪', async () => {
    await shape({ intent: true, line: 'none' });
    expect((await read()).state).toBe('requested');

    // 号绑了但 token 还没铸 —— 仍算「开通中」
    await shape({ intent: true, line: 'active', toolToken: false });
    const r = await read();
    expect(r.state).toBe('requested');
    expect(r.lineBound).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('ready_off —— 本地就绪但今日接听关着', async () => {
    await shape({ intent: true, line: 'active', toolToken: true, aiAnswer: false });
    const r = await read();
    expect(r).toMatchObject({ state: 'ready_off', ready: true, effectiveAiAnswer: false });
  });

  it('on —— 就绪且 ai_answer=true', async () => {
    await shape({ intent: true, line: 'active', toolToken: true, aiAnswer: true });
    const r = await read();
    expect(r).toMatchObject({ state: 'on', ready: true, effectiveAiAnswer: true });
  });

  it('suspended —— 意愿仍在，但曾绑的落地号已被停用', async () => {
    await shape({ intent: true, line: 'inactive', toolToken: true });
    const r = await read();
    expect(r).toMatchObject({ state: 'suspended', lineBound: false, ready: false });
  });

  it('fail-closed —— ai_answer=true 但 token 缺失，有效接听仍为 false', async () => {
    await shape({ intent: true, line: 'active', toolToken: false, aiAnswer: true });
    const r = await read();
    expect(r.ready).toBe(false);
    expect(r.effectiveAiAnswer).toBe(false);
    expect(r.state).toBe('requested');
  });

  it('assistant_id 只作展示，不参与 ready 判定', async () => {
    await shape({ intent: true, line: 'active', toolToken: false, assistantId: true });
    const r = await read();
    expect(r.assistantConfigured).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('老店缺 ai_voice_requested 字段 → intent 为 null，绑了就绪线仍照常推导', async () => {
    await shape({ intent: null, line: 'active', toolToken: true, aiAnswer: true });
    const r = await read();
    expect(r.intent).toBeNull();
    expect(r.state).toBe('on');
  });
});

describe('向导 readiness 里的 aiVoice', () => {
  it('功能关着时 features 步骤仍可完成、不进 warnings、不阻塞开店', async () => {
    await shape({ intent: false, line: 'none' });
    await withTenant(SPA, (tx) => tx`
      update locations set settings = jsonb_set(settings, '{features,confirmed_at}',
        to_jsonb(now()::text), true) where id = ${SPA.locationId}`);
    const readiness = await withTenant(SPA, (tx) => loadSetupReadiness(tx, ctx));
    expect(readiness.aiVoice.state).toBe('unconfigured');
    expect(readiness.steps).toContainEqual({ id: 'features', complete: true });
    expect(readiness.warnings.some((w) => w.code === 'ai_voice_pending')).toBe(false);
  });

  it('意愿开启但未就绪 → ai_voice_pending 警告（仅提示）', async () => {
    await shape({ intent: true, line: 'none' });
    const readiness = await withTenant(SPA, (tx) => loadSetupReadiness(tx, ctx));
    expect(readiness.warnings).toContainEqual({ code: 'ai_voice_pending', stepId: 'features' });
    // 警告不进 missing，canLaunch 只看真实营业前提
    expect(readiness.missing.some((m) => (m.code as string) === 'ai_voice_pending')).toBe(false);
  });
});
