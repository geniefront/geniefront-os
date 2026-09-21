import { readPublicBookingProfile } from '@gf/contracts';
import { readVoiceConfiguration } from '@gf/contracts';
/**
 * 门店全量与各模块配置查询层（Phase 1c / Settings Enhancement）
 */

import type postgres from 'postgres';
import { pickText, type CommandContext, asCents } from '@gf/contracts';
import { readOnlineBooking } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';

export interface LocationSettingsDto {
  id: string;
  name: string;
  /** Globally unique hosted-booking path. Not a secret. */
  slug: string;
  businessType: string;
  phone: string;
  email: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  timezone: string;
  businessDayCutoff: string;
  businessHours: Record<string, { open: string; close: string; periods?: Array<{open:string;close:string}> } | null>;
  status: string;
  hasAddress: boolean;
  profileConfirmedAt: string | null;
}

export interface CheckoutSettingsDto {
  salesTaxRatePercent: number;
  taxCalculationMode: 'exclusive' | 'inclusive';
  suggestedTipPercentages: number[];
  allowCustomTip: boolean;
  defaultCashFloatCents: number;
  receiptFooterMessage: string;
  autoPrintReceipt: boolean;
  autoSendSmsReceipt: boolean;
  checkoutTiming: 'service_then_tip' | 'upfront_combined' | 'after_service_combined';
  packageCoverageMode: 'bundle' | 'any_included';
  packageCommissionBasis: 'catalog_price' | 'allocated_sale_price' | 'zero';
  allowTipSplitOverride: boolean;
  tipDistributionBasis: 'active_minutes' | 'price_share' | 'equal' | 'level_weighted';
  assistantTipWeightPercent: number;
  tipRemainderTo: 'longest_service' | 'highest_level' | 'pool_next_day';
}

export interface IntakeWaiverDto {
  waiverTitle: string;
  waiverContent: string;
  requireSignature: boolean;
  requireHealthAllergies: boolean;
  requirePressurePreference: boolean;
  requireBodySorenessMap: boolean;
  autoCreateCrmProfile: boolean;
  autoPromptTipPercentages: boolean;
  autoSyncToProfile: boolean;
}

export interface TenDlcDto {
  status: 'not_submitted' | 'pending_review' | 'approved' | 'rejected';
  legalBusinessName?: string | null;
  ein?: string | null;
  businessStructure?: string | null;
  registeredAddress?: string | null;
  repName?: string | null;
  repTitle?: string | null;
  repEmail?: string | null;
  repPhone?: string | null;
  optInMethod?: string | null;
  sampleMessages?: string[];
  submittedAt?: string | null;
  submittedByMembershipId?: string | null;
  reviewedAt?: string | null;
  notes?: string | null;
}

export interface WebhookDto {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export async function loadCheckoutSettings(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<CheckoutSettingsDto> {
  const [loc] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${ctx.locationId}`;
  const raw = (loc?.settings?.['checkout'] ?? {}) as Record<string, unknown>;
  const [tipPolicy] = await tx<{ config: Record<string, unknown> }[]>`
    select config from tip_policies
    where location_id = ${ctx.locationId}
    order by effective_from desc, version desc limit 1`;
  const tipConfig = tipPolicy?.config ?? {};
  const roleWeights = (tipConfig['role_weights_bp'] ?? {}) as Record<string, unknown>;
  const custom = {
    packageCoverageMode: (raw['packageCoverageMode'] ?? 'bundle') as CheckoutSettingsDto['packageCoverageMode'],
    packageCommissionBasis: (raw['packageCommissionBasis'] ?? 'allocated_sale_price') as CheckoutSettingsDto['packageCommissionBasis'],
    allowTipSplitOverride: raw['allowTipSplitOverride'] !== false,
    tipDistributionBasis: (tipConfig['basis'] ?? 'active_minutes') as CheckoutSettingsDto['tipDistributionBasis'],
    assistantTipWeightPercent: Math.round(Number(roleWeights['assistant'] ?? 3000) / 100),
    tipRemainderTo: (tipConfig['remainder_to'] ?? 'longest_service') as CheckoutSettingsDto['tipRemainderTo'],
  };
  const [row] = await tx<{
    sales_tax_rate_percent: string;
    tax_calculation_mode: string;
    suggested_tip_percentages: number[];
    allow_custom_tip: boolean;
    default_cash_float_cents: number;
    receipt_footer_message: string | null;
    auto_print_receipt: boolean;
    auto_send_sms_receipt: boolean;
    checkout_timing: string;
  }[]>`
    select sales_tax_rate_percent, tax_calculation_mode,
           suggested_tip_percentages, allow_custom_tip,
           default_cash_float_cents, receipt_footer_message,
           auto_print_receipt, auto_send_sms_receipt, checkout_timing
    from location_checkout_settings
    where location_id = ${ctx.locationId}`;

  if (row) {
    return {
      salesTaxRatePercent: Number(row.sales_tax_rate_percent),
      taxCalculationMode: (row.tax_calculation_mode as 'exclusive' | 'inclusive') || 'exclusive',
      suggestedTipPercentages: row.suggested_tip_percentages || [15, 18, 20, 25],
      allowCustomTip: row.allow_custom_tip ?? true,
      defaultCashFloatCents: asCents(row.default_cash_float_cents ?? 20000),
      receiptFooterMessage: row.receipt_footer_message ?? 'Thank you for your visit!',
      autoPrintReceipt: row.auto_print_receipt ?? true,
      autoSendSmsReceipt: row.auto_send_sms_receipt ?? true,
      checkoutTiming: (row.checkout_timing as CheckoutSettingsDto['checkoutTiming']) || 'after_service_combined',
      ...custom,
    };
  }

  // Fallback to locations.settings['checkout'] or system defaults
  return {
    salesTaxRatePercent: Number(raw['salesTaxRatePercent'] ?? raw['sales_tax_rate_percent'] ?? 0),
    taxCalculationMode: (raw['taxCalculationMode'] ?? raw['tax_calculation_mode'] ?? 'exclusive') as 'exclusive' | 'inclusive',
    suggestedTipPercentages: (raw['suggestedTipPercentages'] ?? raw['suggested_tip_percentages'] ?? [15, 18, 20, 25]) as number[],
    allowCustomTip: raw['allowCustomTip'] !== false && raw['allow_custom_tip'] !== false,
    defaultCashFloatCents: asCents(raw['defaultCashFloatCents'] ?? raw['default_cash_float_cents'] ?? 20000),
    receiptFooterMessage: (raw['receiptFooterMessage'] ?? raw['receipt_footer_message'] ?? 'Thank you for your visit!') as string,
    autoPrintReceipt: raw['autoPrintReceipt'] !== false && raw['auto_print_receipt'] !== false,
    autoSendSmsReceipt: raw['autoSendSmsReceipt'] !== false && raw['auto_send_sms_receipt'] !== false,
    checkoutTiming: (raw['checkoutTiming'] ?? raw['checkout_timing'] ?? 'after_service_combined') as CheckoutSettingsDto['checkoutTiming'],
    ...custom,
  };
}

export async function loadIntakeWaiver(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<IntakeWaiverDto> {
  const [row] = await tx<{
    waiver_title: string;
    waiver_content: string | null;
    require_signature: boolean;
    require_health_allergies: boolean;
    require_pressure_preference: boolean;
    auto_sync_to_profile: boolean;
    require_body_soreness_map: boolean;
    auto_create_crm_profile: boolean;
    auto_prompt_tip_percentages: boolean;
  }[]>`
    select waiver_title, waiver_content, require_signature,
           require_health_allergies, require_pressure_preference, auto_sync_to_profile,
           require_body_soreness_map, auto_create_crm_profile, auto_prompt_tip_percentages
    from location_intake_templates
    where location_id = ${ctx.locationId}`;

  if (row) {
    return {
      waiverTitle: row.waiver_title || '顾客服务知情同意书与健康声明',
      waiverContent: row.waiver_content || '本人确认已如实告知自身健康状况及过敏史，并同意接受本店所提供的专业健康调理/美容美甲服务。',
      requireSignature: row.require_signature ?? true,
      requireHealthAllergies: row.require_health_allergies ?? true,
      requirePressurePreference: row.require_pressure_preference ?? true,
      requireBodySorenessMap: row.require_body_soreness_map ?? true,
      autoCreateCrmProfile: row.auto_create_crm_profile ?? true,
      autoPromptTipPercentages: row.auto_prompt_tip_percentages ?? true,
      autoSyncToProfile: row.auto_sync_to_profile ?? true,
    };
  }

  return {
    waiverTitle: '顾客服务知情同意书与健康声明',
    waiverContent: '本人确认已如实告知自身健康状况及过敏史，并同意接受本店所提供的专业健康调理/美容美甲服务。',
    requireSignature: true,
    requireHealthAllergies: true,
    requirePressurePreference: true,
    requireBodySorenessMap: true,
    autoCreateCrmProfile: true,
    autoPromptTipPercentages: true,
    autoSyncToProfile: true,
  };
}

export async function load10DlcStatus(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<TenDlcDto> {
  const [row] = await tx<{
    status: string;
    legal_business_name: string | null;
    ein: string | null;
    business_structure: string | null;
    registered_address: string | null;
    rep_name: string | null;
    rep_title: string | null;
    rep_email: string | null;
    rep_phone: string | null;
    opt_in_method: string | null;
    sample_messages: string[] | null;
    submitted_at: string | null;
    submitted_by_membership_id: string | null;
    reviewed_at: string | null;
    notes: string | null;
  }[]>`
    select status, legal_business_name, ein, business_structure,
           registered_address, rep_name, rep_title, rep_email, rep_phone,
           opt_in_method, sample_messages,
           submitted_at::text as submitted_at,
           submitted_by_membership_id,
           reviewed_at::text as reviewed_at,
           notes
    from location_10dlc_registrations
    where location_id = ${ctx.locationId}`;

  if (row) {
    return {
      status: (row.status as any) || 'not_submitted',
      legalBusinessName: row.legal_business_name,
      ein: row.ein,
      businessStructure: row.business_structure,
      registeredAddress: row.registered_address,
      repName: row.rep_name,
      repTitle: row.rep_title,
      repEmail: row.rep_email,
      repPhone: row.rep_phone,
      optInMethod: row.opt_in_method,
      sampleMessages: row.sample_messages ?? [],
      submittedAt: row.submitted_at,
      submittedByMembershipId: row.submitted_by_membership_id,
      reviewedAt: row.reviewed_at,
      notes: row.notes,
    };
  }

  return { status: 'not_submitted' };
}

export async function loadWebhooks(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<WebhookDto[]> {
  const rows = await tx<{
    id: string;
    url: string;
    events: string[];
    active: boolean;
    created_at: string;
  }[]>`
    select id, url, events, active, created_at::text as created_at
    from location_webhooks
    where location_id = ${ctx.locationId}
    order by created_at desc`;

  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    events: r.events ?? [],
    active: r.active ?? true,
    createdAt: r.created_at,
  }));
}

export async function loadDeskSettings(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
) {
  const [loc] = await tx<{
    id: string; name: unknown; timezone: string; business_hours: unknown;
    business_type: string; cutoff: string; status: string;
    has_address: boolean; profile_confirmed_at: string | null;
    settings: unknown;
    slug: string; phone: string | null; email: string | null;
    appointment_email_copy_to_shop: boolean;
    address_street: string | null; address_city: string | null;
    address_state: string | null; address_zip: string | null;
    address: Record<string, unknown> | null;
  }[]>`
    select id, name, timezone, business_hours, business_type,
           business_day_cutoff::text as cutoff, status,
           (address is not null or yelp_business_id is not null or address_street is not null) as has_address,
           settings->>'profile_confirmed_at' as profile_confirmed_at,
           settings, slug, phone, email, appointment_email_copy_to_shop,
           address_street, address_city, address_state, address_zip,
           address
    from locations where id = ${ctx.locationId}`;

  const services = await tx<{
    id: string; name: unknown; short_names: Record<string,string>; duration_min: number; base_price_cents: number;
    category_id: string | null;
    taxable: boolean; online_bookable: boolean; is_addon: boolean; active: boolean;
    staff_count: number; required_skill_ids: string[]; updated_at: string;
  }[]>`
    select s.id, s.name, s.short_names, s.category_id, s.duration_min, s.base_price_cents, s.taxable, s.online_bookable,
           s.is_addon, s.active, s.staff_count, s.updated_at::text as updated_at,
           coalesce((select array_agg(ssr.skill_id order by ssr.skill_id)
             from service_skill_requirements ssr where ssr.service_id = s.id), '{}') as required_skill_ids
    from services s where s.location_id = ${ctx.locationId}
    order by s.active desc, s.sort, s.name->>'en'`;

  const serviceCategories = await tx<{ id: string; name: unknown; sort: number }[]>`
    select id, name, sort from service_categories
    where location_id = ${ctx.locationId} order by sort, id`;

  /*
   * 店主邮件语言。事实源是 `organizations.default_locale`（`email/locale.ts`）。
   *
   * ⚠️ 与 `users.locale`（界面语言，按人存）是两件事：前者决定发给店主的
   * 账单类邮件用哪种语言，后者只影响当前登录者看到的界面。
   * 顾客侧的邮件与短信恒为英语，不受该设置影响。
   */
  const [org] = await tx<{ default_locale: string | null }[]>`
    select default_locale from organizations where id = ${ctx.orgId}`;

  const date = businessDateOf(new Date(), loc!.timezone, loc!.cutoff);
  const staff = await tx<{
    membership_id: string; name: unknown; is_bookable: boolean;
    max_concurrent: number; level_key: string | null; in_rotation: boolean | null;
    phone_e164: string | null; has_account: boolean; live_sessions: number;
    role_keys: string[] | null;
  }[]>`
    select sp.membership_id, sp.display_name as name, sp.is_bookable,
           sp.max_concurrent_appointments as max_concurrent,
           sl.key as level_key, rp.in_rotation, sp.phone_e164,
           (m.user_id is not null) as has_account,
           (select count(*) from staff_sessions ss
             where ss.membership_id = sp.membership_id
               and ss.revoked_at is null and ss.expires_at > now())::int as live_sessions,
           (select array_remove(array_agg(r.key), null)
              from membership_roles mr join roles r on r.id = mr.role_id
             where mr.membership_id = sp.membership_id) as role_keys
    from staff_profiles sp
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    left join staff_levels sl on sl.id = sp.level_id
    left join rotation_participants rp
      on rp.membership_id = sp.membership_id and rp.business_date = ${date}
    where sp.location_id = ${ctx.locationId}
    order by sp.is_bookable desc, sp.display_name->>'en'`;

  const levels = await tx<{ id: string; key: string; name: unknown }[]>`
    select id, key, name from staff_levels
    where location_id = ${ctx.locationId} order by sort`;
  const skillCatalog = await tx<{ id: string; key: string; name: unknown; active: boolean }[]>`
    select id, key, name, active from skills where location_id = ${ctx.locationId} order by sort, key`;

  const [web] = await tx<{ public_key: string; slug: string }[]>`
    select public_key, slug from locations where id = ${ctx.locationId}`;

  const origins = await tx<{ id: string; origin: string; label: string | null }[]>`
    select id, origin, label from location_allowed_origins
    where location_id = ${ctx.locationId} order by origin`;

  const lines = await tx<{
    purpose: string; e164: string; forwarding_mode: string | null;
  }[]>`
    select purpose, e164, forwarding_mode from phone_lines
    where location_id = ${ctx.locationId} and active
      and purpose in ('ai_voice','main','transfer_target')`;
  const lineOf = (p: string) => lines.find((l) => l.purpose === p)?.e164 ?? null;

  // Checkout, 10DLC, Intake Waiver, Webhooks
  const checkout = await loadCheckoutSettings(tx, ctx);
  const tenDlc = await load10DlcStatus(tx, ctx);
  const intakeWaiver = await loadIntakeWaiver(tx, ctx);
  const webhooks = await loadWebhooks(tx, ctx);

  const rawOnlineBooking = readOnlineBooking((loc!.settings ?? {}) as Record<string, unknown>);

  const addrObj = (loc!.address && typeof loc!.address === 'object' ? loc!.address : {}) as Record<string, string>;
  const addressStreet = loc!.address_street || addrObj['line1'] || addrObj['street'] || addrObj['address'] || '';
  const addressCity = loc!.address_city || addrObj['city'] || '';
  const addressState = loc!.address_state || addrObj['state'] || '';
  const addressZip = loc!.address_zip || addrObj['zip'] || addrObj['postalCode'] || '';

  return {
    location: {
      id: loc!.id,
      name: pickText(loc!.name, ctx.locale),
      slug: loc!.slug,
      businessType: loc!.business_type || 'mixed',
      phone: loc!.phone || lineOf('main') || '',
      email: loc!.email || '',
      addressStreet,
      addressCity,
      addressState,
      addressZip,
      timezone: loc!.timezone,
      businessDayCutoff: loc!.cutoff.slice(0, 5),
      businessHours: (loc!.business_hours ?? {}) as Record<string, { open: string; close: string; periods?: Array<{open:string;close:string}> } | null>,
      status: loc!.status,
      hasAddress: loc!.has_address,
      profileConfirmedAt: loc!.profile_confirmed_at,
      /** 预约类邮件是否抄送门店自己一份 */
      appointmentEmailCopyToShop: loc!.appointment_email_copy_to_shop,
    },
    /** 发给店主的账单类邮件用哪种语言。顾客侧恒为英语，与此无关 */
    voiceBookingRules: { maxDaysAhead: Number((loc!.settings as any)?.online_booking?.max_days_ahead ?? 60), minMinutesAhead: Number((loc!.settings as any)?.online_booking?.min_minutes_ahead ?? 30) },
    voiceNotifications: readVoiceConfiguration(loc!.settings, { email: loc!.email, phone: loc!.phone }).voiceNotifications,
    emailLocale: org?.default_locale ?? 'en',
    checkout,
    publicBookingResourceTypes: await tx<{id:string;name:unknown}[]>`select id,name from resource_types where location_id=${ctx.locationId}`,
    publicBookingProfile: readPublicBookingProfile(loc!.settings as Record<string,unknown>),
    guest: {
      publicKey: web!.public_key,
      slug: web!.slug,
      allowedOrigins: origins,
      onlineBooking: rawOnlineBooking,
      onlineBookableCount: services.filter((x) => x.active && x.online_bookable).length,
    },
    services: services.map((s) => ({
      id: s.id,
      categoryId: s.category_id,
      name: s.name as Record<string, string>,
      shortNames: s.short_names,
      displayName: pickText(s.name, ctx.locale),
      presentation: readPublicBookingProfile(loc!.settings as Record<string,unknown>).services[s.id],
      durationMin: s.duration_min,
      basePriceCents: s.base_price_cents,
      taxable: s.taxable,
      onlineBookable: s.online_bookable,
      isAddon: s.is_addon,
      staffCount: s.staff_count,
      requiredSkillIds: s.required_skill_ids,
      active: s.active,
      updatedAt: s.updated_at,
    })),
    serviceCategories: serviceCategories.map((category) => ({
      id: category.id,
      name: category.name as Record<string, string>,
      displayName: pickText(category.name, ctx.locale),
      sort: category.sort,
    })),
    staff: staff.map((s) => ({
      membershipId: s.membership_id,
      name: pickText(s.name, ctx.locale),
      isBookable: s.is_bookable,
      maxConcurrent: s.max_concurrent,
      levelKey: s.level_key,
      inRotation: s.in_rotation ?? s.is_bookable,
      roleKeys: s.role_keys ?? [],
      phoneE164: s.phone_e164,
      hasAccount: s.has_account,
      liveSessions: s.live_sessions,
    })),
    levels: levels.map((l) => ({
      id: l.id,
      key: l.key,
      name: pickText(l.name, ctx.locale),
    })),
    skills: skillCatalog.map((skill) => ({
      id: skill.id,
      key: skill.key,
      name: pickText(skill.name, ctx.locale, skill.key),
      active: skill.active,
    })),
    phone: {
      storefrontE164: lineOf('main'),
      transferTargetE164: lineOf('transfer_target'),
      aiVoiceE164: lineOf('ai_voice'),
      forwardingMode: lines.find((l) => l.purpose === 'main')?.forwarding_mode ?? null,
    },
    phoneAssistant: {
      ...readVoiceConfiguration(loc!.settings, { email: loc!.email, phone: loc!.phone }).phoneAssistant,
      forwardPhoneNumber: lineOf('transfer_target')
        ?? ((loc!.settings as any)?.phone_assistant ?? (loc!.settings as any)?.phoneAssistant)?.forwardPhoneNumber ?? '',
    },
    tenDlc,
    intakeWaiver,
    webhooks,
  };
}
