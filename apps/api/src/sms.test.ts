/**
 * 短信：分段计数、关键词、文案。
 *
 * 这一份盯的是两样**错了会真出事**的东西：
 *
 *   **分段** —— 算少了我们贴钱，而且是每条都贴，按月加总才发现
 *   **关键词** —— 认少了违规（无视 STOP），认多了把想改时间的客人
 *                 永久踢出短信通道
 *
 * 文案那几条不是审美测试，是**成本测试**：只要有一个字符掉出 GSM-7，
 * 每条短信的容量就从 160 掉到 70，成本翻倍而客人看到的完全一样。
 */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { renderTemplate } from '@gf/contracts';
import { measure, segmentsOf } from './sms/segments';
import { classify, KEYWORDS } from './sms/keywords';
import {
  renderConfirmSms, renderHelpSms, smsShopName, prettyPhone,
  withComplianceFooter, SENDER, OPT_OUT_NOTICE,
} from './sms/render';
import { loadInboundSms } from './queries/smsInbound';
import { withTenant, closeDb, recordInboundSms, setSmsConsent } from '@gf/db';
import { buildContext } from './actor';

describe('分段计数', () => {
  it('纯英文走 GSM-7', () => {
    expect(measure('Hello')).toMatchObject({ encoding: 'GSM-7', units: 5, segments: 1 });
  });

  it('160 是一段，161 就是两段', () => {
    expect(segmentsOf('a'.repeat(160))).toBe(1);
    expect(segmentsOf('a'.repeat(161))).toBe(2);
  });

  it('⭐ 拼接按 153 切，不是 160 —— 每段要留 6 字节 UDH 头', () => {
    expect(segmentsOf('a'.repeat(306))).toBe(2);   // 153 × 2
    expect(segmentsOf('a'.repeat(307))).toBe(3);
    expect(segmentsOf('a'.repeat(459))).toBe(3);   // 153 × 3
  });

  it('⭐ 一个中文字符就把整条推进 UCS-2 —— 容量从 160 掉到 70', () => {
    const ascii = 'a'.repeat(100);
    expect(measure(ascii)).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(measure(ascii + '莲')).toMatchObject({ encoding: 'UCS-2', segments: 2 });
  });

  it('UCS-2 下 70 一段、67 拼接', () => {
    expect(segmentsOf('中'.repeat(70))).toBe(1);
    expect(segmentsOf('中'.repeat(71))).toBe(2);
    expect(segmentsOf('中'.repeat(134))).toBe(2);   // 67 × 2
    expect(segmentsOf('中'.repeat(135))).toBe(3);
  });

  it('⭐ emoji 是代理对，占两个码元 —— 按「字符」数会少算一半', () => {
    // 35 个 emoji = 70 个 UTF-16 码元 = 刚好一段
    expect(measure('😀'.repeat(35))).toMatchObject({ encoding: 'UCS-2', units: 70, segments: 1 });
    expect(segmentsOf('😀'.repeat(36))).toBe(2);
  });

  it('GSM 扩展字符各占两个 septet', () => {
    // { } [ ] ~ ^ | \ € 这几个要转义
    expect(measure('{')).toMatchObject({ encoding: 'GSM-7', units: 2 });
    expect(segmentsOf('{'.repeat(80))).toBe(1);    // 160 septet
    expect(segmentsOf('{'.repeat(81))).toBe(2);
  });

  it('空串也算一段 —— 别返回 0 让计费变成免费', () => {
    expect(segmentsOf('')).toBe(1);
  });

  it('⭐ 花引号是最容易混进来的非 GSM 字符', () => {
    // 直引号没问题，弯引号（很多编辑器自动替换）直接把整条推进 UCS-2
    expect(measure("You're booked").encoding).toBe('GSM-7');
    expect(measure('You’re booked').encoding).toBe('UCS-2');
  });
});

describe('入站关键词', () => {
  it('店主在 Telnyx 登记的三组词，一个不漏', () => {
    for (const w of ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT']) expect(classify(w)).toBe('opt_out');
    for (const w of ['START', 'YES']) expect(classify(w)).toBe('opt_in');
    for (const w of ['HELP', 'INFO']) expect(classify(w)).toBe('help');
  });

  it('大小写和结尾标点都要认 —— 手机键盘会自动补', () => {
    expect(classify('stop')).toBe('opt_out');
    expect(classify('Stop.')).toBe('opt_out');
    expect(classify('  STOP!  ')).toBe('opt_out');
    expect(classify('help?')).toBe('help');
  });

  it('⭐ 整条只有这一个词才算，不做包含匹配', () => {
    // 「能不能取消我三点那个」不是退订 —— 判成退订等于把一个
    // 想改时间的客人**永久**踢出短信通道
    expect(classify('Can you cancel my 3pm?')).toBe('unknown');
    expect(classify('STOP IT')).toBe('unknown');
    expect(classify('I need help with my booking')).toBe('unknown');
    expect(classify('yes please')).toBe('unknown');
  });

  it('认不出的照样有归类，不会变成 undefined', () => {
    expect(classify('')).toBe('unknown');
    expect(classify('👍')).toBe('unknown');
  });

  it('导出的清单和实现一致（HELP 回复要用）', () => {
    expect(KEYWORDS.optOut).toContain('CANCEL');
    expect(KEYWORDS.optIn).toEqual(['START', 'YES']);
  });
});

describe('文案', () => {
  const base = {
    shopName: { en: 'Lotus Nails', 'zh-Hans': '莲花美甲' },
    serviceName: 'Gel Manicure',
    whenText: 'Wed Aug 26, 12:30 PM',
    shopPhone: '+16175550142',
  };

  it('⭐ 确认短信必须是 GSM-7 的一段 —— 两段就是成本翻倍', () => {
    const body = renderConfirmSms(base);
    const m = measure(body);
    expect(m.encoding).toBe('GSM-7');
    expect(m.segments).toBe(1);
  });

  it('⭐ 店名强制取英文 —— 中文店名会把整条推进 UCS-2', () => {
    expect(smsShopName({ en: 'Lotus Nails', 'zh-Hans': '莲花美甲' })).toBe('Lotus Nails');
    expect(smsShopName({ 'zh-Hans': '莲花美甲 Lotus' })).toBe('Lotus');
    // 中文店名进不了正文，整条仍然是 GSM-7
    expect(measure(renderConfirmSms({ ...base, shopName: { 'zh-Hans': '莲花美甲' } })).encoding)
      .toBe('GSM-7');
  });

  it('⭐ 只有中文店名时用 slug 还原 —— 署名「Salon」看起来就是诈骗短信', () => {
    expect(smsShopName({ 'zh-Hans': '莲花美甲' }, 'lotus-nails')).toBe('Lotus Nails');
    // 建店时 slug 尾巴上那段防重的随机 hex 不该出现在客人眼前
    expect(smsShopName({ 'zh-Hans': '金足足疗' }, 'golden-foot-a1b2c3')).toBe('Golden Foot');
    // slug 也没有才轮到兜底
    expect(smsShopName({ 'zh-Hans': '莲花美甲' })).toBe('Salon');
    expect(smsShopName({}, null)).toBe('Salon');
  });

  it('slug 回退进得了正文，而且照样是一段', () => {
    const body = renderConfirmSms({ ...base, shopName: { 'zh-Hans': '莲花美甲' }, shopSlug: 'lotus-nails' });
    expect(body.startsWith('GenieFront: ')).toBe(true);
    expect(body).toContain('at Lotus Nails');
    expect(measure(body).segments).toBe(1);
  });

  it('🔴 正文里一个字都不许提「回复 CANCEL」', () => {
    // CANCEL 是运营商强制的**退订**关键词。在预约短信里教客人回 CANCEL
    // 等于亲手让他退订，而他以为自己取消了预约
    const body = renderConfirmSms(base);
    expect(body.toUpperCase()).not.toContain('REPLY CANCEL');
    expect(body.toUpperCase()).not.toContain('TEXT CANCEL');
    expect(body).toContain('call');          // 改期一律引导打电话
  });

  it('⭐ 署名是 GenieFront，不是店名 —— 但店名要在正文里', () => {
    /*
     * 2026-08-24 店主定的。理由不只是品牌：发送号是**平台号**，
     * 10DLC 注册的品牌也是 GenieFront。署名店名而号码是平台的，
     * 在运营商眼里就是「发送者与注册品牌不符」—— 那一类最容易被判成
     * 欺骗性流量，掐的是整条通道，不是这一条短信。
     */
    const body = renderConfirmSms(base);
    expect(body.startsWith('GenieFront: ')).toBe(true);
    expect(body).toContain('at Lotus Nails');       // 客人照样知道是哪家店
    expect(body).toContain('Reply STOP to opt out');
  });

  it('店名一个字都拼不出来时，宁可不写「at …」', () => {
    // 「booked at Salon」看起来像模板没渲染出来，比不写更糟
    const body = renderConfirmSms({ ...base, shopName: {}, shopSlug: null });
    expect(body.startsWith('GenieFront: Booked ')).toBe(true);
    expect(body).not.toContain(' at ');
  });

  it('电话进正文，且是能直接念的格式', () => {
    const body = renderConfirmSms(base);
    expect(body).toContain('(617) 555-0142');
    expect(prettyPhone('+16175550142')).toBe('(617) 555-0142');
    expect(prettyPhone(null)).toBeNull();
  });

  /**
   * ⭐ 预约码不进短信（2026-09-01 店主定）——
   * 前台在 iPad 上用手机号就查得到，而它要占掉可用长度的十六分之一。
   */
  it('🔴 正文里不出现预约码', () => {
    const body = renderConfirmSms(base);
    expect(body).not.toContain('Code');
  });

  it('没电话也要能发出去', () => {
    const body = renderConfirmSms({ ...base, shopPhone: null });
    expect(measure(body).segments).toBe(1);
    expect(body).toContain('Call the salon');
  });

  it('⭐ 店名和项目名再长也压进一段 —— 砍项目名，不砍店名和电话', () => {
    const body = renderConfirmSms({
      ...base,
      shopName: { en: 'Golden Lotus Nails and Day Spa' },
      serviceName: 'Deluxe Spa Pedicure with Callus Treatment',
    });
    expect(measure(body).segments).toBe(1);
    // 砍的是项目名
    expect(body).toContain('...');
    // 这两样一个字都不能少：认不出谁发的、或者打不了电话，这条短信就白发了
    expect(body.startsWith('GenieFront: ')).toBe(true);
    // 店名可以退让（身份锚点是 GenieFront 那个署名），但要留得住辨识度
    expect(body).toContain('at Golden Lotus');
    expect(body).toContain('(617) 555-0142');
    expect(body).toContain('Reply STOP to opt out');
  });

  it('项目名短到没意义就不砍了 —— 宁可两段', () => {
    // 极端构造：光是店名+时间+电话+退订说明就快满了
    const body = renderConfirmSms({
      ...base,
      shopName: { en: 'A'.repeat(24) },
      serviceName: 'B'.repeat(200),
      whenText: 'Wednesday August 26, 12:30 PM',
    });
    // 砍到下限之后剩下的部分仍然认得出是个项目名
    expect(/B{16,}/.test(body)).toBe(true);
  });

  it('默认短信模板在最坏变量下仍是 GSM-7', () => {
    const worst: Record<string, string> = {
      shop_name: 'Golden Lotus Nails and Day Spa',
      service_name: 'Deluxe Spa Pedicure with Callus',
      when: 'Wed Aug 26, 12:30 PM',
      shop_phone: '(617) 555-0142',
      customer_name: 'Christopher Alexander',
      old_when: 'Tue Aug 25, 11:00 AM',
      days_since: '365',
      holiday_name: 'Independence Day',
    };
    const templates = [
      'Booked: {{service_name}} at {{shop_name}}, {{when}}. Changes: {{shop_phone}}.',
      'Your appointment at {{shop_name}} moved to {{when}}. Questions? Call {{shop_phone}}.',
      'Cancelled: {{shop_name}}, {{when}}. Call {{shop_phone}} to rebook.',
      'Reminder: {{shop_name}}, {{when}}. Changes: {{shop_phone}}.',
      'Happy birthday from {{shop_name}}! Call {{shop_phone}} to book.',
      '{{holiday_name}} greetings from {{shop_name}}! Call {{shop_phone}} to book.',
      'We miss you at {{shop_name}} - it has been {{days_since}} days. Call {{shop_phone}}.',
    ];
    for (const tpl of templates) {
      const body = withComplianceFooter(renderTemplate(tpl, worst));
      expect(measure(body).encoding, tpl).toBe('GSM-7');
    }
  });

  it('HELP 回复:身份 + 用途 + 资费 + 退订，一段装得下', () => {
    const body = renderHelpSms();
    const m = measure(body);
    expect(m.encoding).toBe('GSM-7');
    expect(m.segments).toBe(1);
    expect(body).toContain('STOP');
    expect(body).toContain('Msg&data rates may apply');
  });
});

// ───────────────────────────────────────────────── 前台看得到客人发了什么

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

afterAll(async () => { await closeDb(); });

describe('入站短信列表（docs/09 §5.3）', () => {
  it('⭐ 发了 CANCEL 但预约还在 → 标成「要处理」', async () => {
    const phone = `+1617444${String(Math.floor(Math.random() * 9000) + 1000)}`;

    const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
      select m.id, m.user_id from memberships m
      join membership_roles mr on mr.membership_id = m.id
      join roles r on r.id = mr.role_id
      where m.location_id = ${NAIL_LOC} and m.status = 'active'
        and r.key in ('owner','manager') limit 1`);
    const ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

    // 一个本店客户 + 一条还没到的预约
    const [svc] = await withTenant(tenant, (tx) => tx<{ id: string; duration_min: number }[]>`
      select id, duration_min from services where location_id = ${NAIL_LOC} and active limit 1`);
    const startsAt = new Date(Date.now() + 3 * 86400_000);

    const ids = await withTenant(tenant, async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        insert into customers (org_id, primary_location_id, display_name, phone_e164, source)
        values (${NAIL_ORG}, ${NAIL_LOC}, 'Cancel Tester', ${phone}, 'web') returning id`;
      const [a] = await tx<{ id: string }[]>`
        insert into appointments (org_id, location_id, customer_id, business_date,
                                  starts_at, ends_at, source, confirmation_code)
        values (${NAIL_ORG}, ${NAIL_LOC}, ${c!.id}, ${startsAt.toISOString().slice(0, 10)},
                ${startsAt.toISOString()}::timestamptz,
                ${new Date(startsAt.getTime() + 3600_000).toISOString()}::timestamptz,
                'web', ${'LO-' + randomUUID().slice(0, 4).toUpperCase()}) returning id`;
      await tx`insert into appointment_items
        (org_id, location_id, appointment_id, service_id, starts_at, ends_at,
         price_cents_snapshot, duration_min)
        values (${NAIL_ORG}, ${NAIL_LOC}, ${a!.id}, ${svc!.id},
                ${startsAt.toISOString()}::timestamptz,
                ${new Date(startsAt.getTime() + 3600_000).toISOString()}::timestamptz,
                0, ${svc!.duration_min})`;
      return { customerId: c!.id, appointmentId: a!.id };
    });

    await recordInboundSms({ fromE164: phone, toE164: '+17577706256',
                             body: 'CANCEL', intent: 'opt_out' });
    await setSmsConsent(phone, 'opted_out', 'CANCEL');

    const out = await withTenant(tenant, (tx) => loadInboundSms(tx, ctx, 14));
    const mine = out.messages.find((x) => x.fromE164 === phone);

    expect(mine).toBeTruthy();
    expect(mine!.body).toBe('CANCEL');
    expect(mine!.intent).toBe('opt_out');
    // 认得出是本店哪位客人
    expect(mine!.customers.map((c) => c.name)).toContain('Cancel Tester');
    // ⭐ 关键：他退订了，但这条预约**还在**
    expect(mine!.upcoming.map((u) => u.appointmentId)).toContain(ids.appointmentId);
    expect(out.needsAttention).toBeGreaterThan(0);

    await withTenant(tenant, async (tx) => {
      await tx`delete from appointments where id = ${ids.appointmentId}`;
      await tx`delete from customers where id = ${ids.customerId}`;
    });
  });

  it('⭐ 别的店的客人发来的短信，这家店查不到', async () => {
    // sms_inbound 是平台级的表（客人回的是平台号，不属于任何一家店）。
    // 前台只该看到**自己店客户**的号码发来的东西
    const stranger = `+1415777${String(Math.floor(Math.random() * 9000) + 1000)}`;
    await recordInboundSms({ fromE164: stranger, toE164: '+17577706256',
                             body: 'STOP', intent: 'opt_out' });

    const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
      select m.id, m.user_id from memberships m
      join membership_roles mr on mr.membership_id = m.id
      join roles r on r.id = mr.role_id
      where m.location_id = ${NAIL_LOC} and m.status = 'active'
        and r.key in ('owner','manager') limit 1`);
    const ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

    const out = await withTenant(tenant, (tx) => loadInboundSms(tx, ctx, 14));
    expect(out.messages.some((x) => x.fromE164 === stranger)).toBe(false);
  });
});


describe('合规兜底：署名与退订说明', () => {
  /**
   * ⭐ 前台手打的短信此前既无署名也无退订说明。两者都不是可选项：
   * 发送号是平台号、10DLC 注册品牌是 GenieFront，收件人无法由号码识别
   * 发送方；而退订是平台级行为，缺失即构成合规缺陷。
   */
  it('自由文本补齐署名与退订说明', () => {
    const out = withComplianceFooter('Your table is ready.');
    expect(out.startsWith(`${SENDER}:`)).toBe(true);
    expect(out.endsWith(OPT_OUT_NOTICE)).toBe(true);
  });

  it('已经带了的不重复添加 —— 模板类短信自身已带', () => {
    const once = renderConfirmSms({
      shopName: { en: 'Lotus Nails' }, shopSlug: 'lotus-nails-a1b2c3',
      serviceName: 'Gel Manicure', whenText: 'Wed Aug 26, 12:30 PM',
      shopPhone: '+16175550142',
    });
    expect(withComplianceFooter(once)).toBe(once);
  });

  it('大小写不同的 STOP 说明也认得出，不会加第二条', () => {
    const out = withComplianceFooter('Hi there. reply stop to opt out.');
    expect(out.match(/reply\s+stop/gi)?.length).toBe(1);
  });
});
