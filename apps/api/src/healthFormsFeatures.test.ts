import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeDb, withTenant } from '@gf/db';
import {
  INDUSTRY_HEALTH_FORM_PRESETS,
  SaveFormTemplate,
  healthFormTemplateKeyForBusinessType,
} from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadForms } from './queries/forms';
import { loadSetupReadiness } from './queries/setupReadiness';
import './handlers/kiosk';
import './handlers/setup';

const NAIL = {
  orgId: '11111111-1111-4111-8111-111111111111',
  locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  membershipId: null,
};
const SPA = {
  orgId: '22222222-2222-4222-8222-222222222222',
  locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  membershipId: null,
};

let nailCtx: Awaited<ReturnType<typeof buildContext>>;
let spaCtx: Awaited<ReturnType<typeof buildContext>>;

async function ownerContext(tenant: typeof NAIL) {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${tenant.locationId} and m.status = 'active'
      and m.user_id is not null and r.key in ('owner','manager') limit 1`);
  return buildContext({ userId: owner!.user_id, membershipId: owner!.id });
}

const run = <T>(name: string, input: unknown, ctx: typeof nailCtx) =>
  dispatch<T>(name, input, ctx, { idempotencyKey: randomUUID() });

beforeAll(async () => {
  process.env['FORM_ENCRYPTION_KEY'] ??= randomBytes(32).toString('hex');
  nailCtx = await ownerContext(NAIL);
  spaCtx = await ownerContext(SPA);
});

afterAll(async () => {
  await withTenant(SPA, (tx) => tx`
    update form_submissions set answers_encrypted = null, anonymized_at = now()
    where location_id = ${SPA.locationId} and anonymized_at is null`);
  await closeDb();
});

describe('shared health-form presets', () => {
  it('keeps all six real industry presets valid and keyed to business types', () => {
    expect(INDUSTRY_HEALTH_FORM_PRESETS).toHaveLength(6);
    for (const preset of INDUSTRY_HEALTH_FORM_PRESETS) {
      expect(SaveFormTemplate.input.safeParse(preset.template).success, preset.id).toBe(true);
    }
    expect(healthFormTemplateKeyForBusinessType('nail')).toBe('nail_pedicure_intake');
    expect(healthFormTemplateKeyForBusinessType('foot_spa')).toBe('massage_intake');
  });
});

describe('explicit feature choices', () => {
  it('treats false as a completed choice and preserves the published template', async () => {
    const [before] = await withTenant(NAIL, (tx) => tx<{ id: string }[]>`
      select id from form_templates where location_id = ${NAIL.locationId}
        and key = 'nail_pedicure_intake' and active and published_at is not null`);
    const saved = await run<{
      healthFormsEnabled: boolean | null;
      effectiveHealthFormsEnabled: boolean;
      aiVoiceRequested: boolean | null;
      confirmedAt: string | null;
    }>('settings.saveSetupFeatures', {
      healthFormsEnabled: false,
      aiVoiceRequested: false,
      confirmSetup: true,
    }, nailCtx);
    expect(saved.result).toMatchObject({
      healthFormsEnabled: false,
      effectiveHealthFormsEnabled: false,
      aiVoiceRequested: false,
    });
    expect(saved.result.confirmedAt).toBeTruthy();

    const forms = await withTenant(NAIL, (tx) => loadForms(tx, nailCtx));
    expect(forms.healthForms.enabled).toBe(false);
    expect(forms.healthForms.effectiveEnabled).toBe(false);
    expect(forms.templates.some((template) => template.templateId === before!.id)).toBe(true);
    const readiness = await withTenant(NAIL, (tx) => loadSetupReadiness(tx, nailCtx));
    expect(readiness.steps).toContainEqual({ id: 'features', complete: true });

    await expect(run('form.share', { templateIds: [before!.id] }, nailCtx))
      .rejects.toMatchObject({ details: { reason: 'health_forms_disabled' } });
  });

  it('re-enabling reuses a customized published version instead of replacing it', async () => {
    const custom = await run<{ templateId: string; version: number }>(
      'catalog.saveFormTemplate', {
        key: 'nail_pedicure_intake',
        title: { en: 'My custom nail waiver' },
        questions: [{ id: 'custom_safety', type: 'bool', required: true,
          label: { en: 'Do you have a condition we should discuss?' } }],
        requiresSignature: true,
        validDays: 180,
        serviceIds: [],
      }, nailCtx);
    const enabled = await run<{ healthFormTemplateId: string | null; healthFormTemplateVersion: number | null }>(
      'settings.saveSetupFeatures', { healthFormsEnabled: true }, nailCtx);
    expect(enabled.result.healthFormTemplateId).toBe(custom.result.templateId);
    expect(enabled.result.healthFormTemplateVersion).toBe(custom.result.version);

    const [row] = await withTenant(NAIL, (tx) => tx<{ title: Record<string, string> }[]>`
      select title from form_templates where id = ${custom.result.templateId}`);
    expect(row!.title.en).toBe('My custom nail waiver');
  });

  it('keeps legacy stores without an explicit switch enabled when a publication exists', async () => {
    await withTenant(NAIL, (tx) => tx`
      update locations set settings = settings #- '{features,health_forms_enabled}'
      where id = ${NAIL.locationId}`);
    try {
      const forms = await withTenant(NAIL, (tx) => loadForms(tx, nailCtx));
      expect(forms.healthForms.enabled).toBeNull();
      expect(forms.healthForms.effectiveEnabled).toBe(true);
    } finally {
      await withTenant(NAIL, (tx) => tx`
        update locations set settings = jsonb_set(
          settings, '{features,health_forms_enabled}', 'true'::jsonb, true
        ) where id = ${NAIL.locationId}`);
    }
  });
});

describe('transactional first publication', () => {
  it('preserves an unpublished row and concurrent enables publish only one version', async () => {
    await withTenant(SPA, async (tx) => {
      await tx`delete from form_templates where location_id = ${SPA.locationId}
        and key = 'massage_intake'`;
      await tx`insert into form_templates
        (org_id, location_id, key, version, title, schema, requires_signature, active)
        values (${SPA.orgId}, ${SPA.locationId}, 'massage_intake', 1,
          '{"en":"Unpublished local draft"}'::jsonb, '[]'::jsonb, true, true)`;
      await tx`update locations set settings = jsonb_set(settings,
        '{features,health_forms_enabled}', 'false'::jsonb, true)
        where id = ${SPA.locationId}`;
    });

    const results = await Promise.all([
      run<{ healthFormTemplateId: string | null }>(
        'settings.saveSetupFeatures', { healthFormsEnabled: true }, spaCtx),
      run<{ healthFormTemplateId: string | null }>(
        'settings.saveSetupFeatures', { healthFormsEnabled: true }, spaCtx),
    ]);
    expect(results[0].result.healthFormTemplateId).toBe(results[1].result.healthFormTemplateId);
    const rows = await withTenant(SPA, (tx) => tx<{
      version: number; published_at: string | null; active: boolean; title: Record<string, string>;
    }[]>`select version, published_at, active, title from form_templates
      where location_id = ${SPA.locationId} and key = 'massage_intake' order by version`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 1, published_at: null, active: false });
    expect(rows[0]!.title.en).toBe('Unpublished local draft');
    expect(rows[1]).toMatchObject({ version: 2, active: true });
    expect(rows[1]!.published_at).toBeTruthy();

    const shared = await run<{ shareId: string }>('form.share', {}, spaCtx);
    expect(shared.result.shareId).toBeTruthy();

    const preset = SaveFormTemplate.input.parse(
      INDUSTRY_HEALTH_FORM_PRESETS.find((item) => item.template.key === 'massage_intake')!.template,
    );
    const answers = Object.fromEntries(preset.questions
      .filter((question) => question.required && !question.hidden)
      .map((question) => {
        if (question.type === 'bool') return [question.id, false];
        if (question.type === 'text') return [question.id, 'None'];
        if (question.type === 'choice') return [question.id, question.options![0]!.value];
        return [question.id, [question.options![0]!.value]];
      }));
    const submitted = await run<{ submissionId: string }>('form.submit', {
      templateId: results[0].result.healthFormTemplateId,
      answers,
      signerName: 'S3 acceptance',
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      source: 'desk',
    }, spaCtx);
    expect(submitted.result.submissionId).toBeTruthy();
  });

  it('manual publication and enable with different keys cannot collide on a version', async () => {
    const preset = INDUSTRY_HEALTH_FORM_PRESETS.find(
      (item) => item.template.key === 'massage_intake',
    )!;
    const [manual, enabled] = await Promise.all([
      run<{ templateId: string; version: number }>(
        'catalog.saveFormTemplate', {
          ...preset.template,
          title: { ...preset.template.title, en: 'Concurrent custom publication' },
        }, spaCtx),
      run<{ healthFormTemplateId: string | null }>(
        'settings.saveSetupFeatures', { healthFormsEnabled: true }, spaCtx),
    ]);
    expect(manual.result.templateId).toBeTruthy();
    expect(enabled.result.healthFormTemplateId).toBeTruthy();
    const rows = await withTenant(SPA, (tx) => tx<{ version: number; active: boolean }[]>`
      select version, active from form_templates
      where location_id = ${SPA.locationId} and key = 'massage_intake'
        and published_at is not null order by version`);
    expect(new Set(rows.map((row) => row.version)).size).toBe(rows.length);
    expect(rows.filter((row) => row.active)).toHaveLength(1);
  });
});
