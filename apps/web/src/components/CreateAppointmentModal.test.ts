/**
 * 新建预约弹窗里两段容易出隐性 bug 的纯逻辑：
 *
 *  1. `resolveInitialDateTime` —— 打开弹窗默认落在哪天哪个钟点。
 *     U03「预约偶尔变昨天」的根因是默认日期取了营业日（cutoff 前 = 昨天）
 *     而不是门店的日历日；这里锁定「无 defaultDate 时用日历日今天」。
 *
 *  2. `parseDuration` —— 时长输入的校验。历史上 `parseInt(v) || 30` 把空值、
 *     0、`"60abc"` 静默变成合法数字（U11）。
 */
import { describe, it, expect } from 'vitest';
import { resolveInitialDateTime, parseDuration, buildBundleSelections } from './CreateAppointmentModal';

// 门店 10:00–21:00
const OPEN = 10 * 60;
const CLOSE = 21 * 60;

describe('resolveInitialDateTime', () => {
  it('无 defaultDate：落在传入的日历日今天，不是营业日', () => {
    // 调用方在 cutoff 前算出的 calendarToday 仍是日历日（09-07），
    // 即使此刻的营业日还是 09-06
    const r = resolveInitialDateTime({
      calendarToday: '2026-09-07',
      nowWallMinutes: 1 * 60 + 30, // 门店墙上 01:30
      openMin: OPEN,
      closeMin: CLOSE,
    });
    expect(r.date).toBe('2026-09-07');
  });

  it('今天 + 营业时段内：门店墙上钟点按 30 分钟向上取整', () => {
    const r = resolveInitialDateTime({
      calendarToday: '2026-09-07',
      nowWallMinutes: 14 * 60 + 5, // 14:05
      openMin: OPEN,
      closeMin: CLOSE,
    });
    expect(r).toEqual({ date: '2026-09-07', time: '14:30' });
  });

  it('今天但还没开门 / 已打烊：退到开门时间，不排一个营业时段外的默认', () => {
    expect(
      resolveInitialDateTime({ calendarToday: '2026-09-07', nowWallMinutes: 7 * 60, openMin: OPEN, closeMin: CLOSE }).time,
    ).toBe('10:00');
    expect(
      resolveInitialDateTime({ calendarToday: '2026-09-07', nowWallMinutes: 23 * 60, openMin: OPEN, closeMin: CLOSE }).time,
    ).toBe('10:00');
  });

  it('未来日期：从开门时间起，不把「现在」的钟点套上去', () => {
    const r = resolveInitialDateTime({
      defaultDate: '2026-09-20',
      calendarToday: '2026-09-07',
      nowWallMinutes: 14 * 60 + 5,
      openMin: OPEN,
      closeMin: CLOSE,
    });
    expect(r).toEqual({ date: '2026-09-20', time: '10:00' });
  });

  it('历史补录（过去日期）：同样从开门时间起', () => {
    const r = resolveInitialDateTime({
      defaultDate: '2026-09-01',
      calendarToday: '2026-09-07',
      nowWallMinutes: 14 * 60,
      openMin: OPEN,
      closeMin: CLOSE,
    });
    expect(r).toEqual({ date: '2026-09-01', time: '10:00' });
  });

  it('日历格子：defaultDate + defaultTime 都按明确选择，不改', () => {
    const r = resolveInitialDateTime({
      defaultDate: '2026-09-06',
      defaultTime: '13:15',
      calendarToday: '2026-09-07',
      nowWallMinutes: 9 * 60,
      openMin: OPEN,
      closeMin: CLOSE,
    });
    expect(r).toEqual({ date: '2026-09-06', time: '13:15' });
  });

  it('日历页顶部新建：传了昨天（用户正在看昨天）就默认昨天，不偷偷跳今天', () => {
    const r = resolveInitialDateTime({
      defaultDate: '2026-09-06',
      calendarToday: '2026-09-07',
      nowWallMinutes: 14 * 60,
      openMin: OPEN,
      closeMin: CLOSE,
    });
    expect(r).toEqual({ date: '2026-09-06', time: '10:00' });
  });

  // 跨午夜营业：10:00 开、次日 02:00 打烊（closeMin = 26:00 = 1560）
  const XM_OPEN = 10 * 60;
  const XM_CLOSE = 26 * 60;

  it('跨午夜营业 · 凌晨 01:30 仍在营业段：默认当前钟点，不退回开门时间', () => {
    const r = resolveInitialDateTime({
      calendarToday: '2026-09-08', // instantToWallDate 在凌晨已是次日日历日
      nowWallMinutes: 1 * 60 + 30,
      openMin: XM_OPEN,
      closeMin: XM_CLOSE,
    });
    expect(r).toEqual({ date: '2026-09-08', time: '01:30' });
  });

  it('跨午夜营业 · 凌晨 05:00 已过延长营业段：退回开门时间', () => {
    const r = resolveInitialDateTime({
      calendarToday: '2026-09-08',
      nowWallMinutes: 5 * 60,
      openMin: XM_OPEN,
      closeMin: XM_CLOSE,
    });
    expect(r.time).toBe('10:00');
  });

  it('跨午夜营业 · 傍晚 20:00 走常规窗口，不误判成延长段', () => {
    const r = resolveInitialDateTime({
      calendarToday: '2026-09-07',
      nowWallMinutes: 20 * 60,
      openMin: XM_OPEN,
      closeMin: XM_CLOSE,
    });
    expect(r).toEqual({ date: '2026-09-07', time: '20:00' });
  });

  it('非跨午夜门店 · 凌晨 01:30：维持旧行为，退回开门时间', () => {
    const r = resolveInitialDateTime({
      calendarToday: '2026-09-07',
      nowWallMinutes: 1 * 60 + 30,
      openMin: OPEN,
      closeMin: CLOSE, // 21:00，未跨午夜
    });
    expect(r.time).toBe('10:00');
  });
});

describe('parseDuration', () => {
  it('合法：1–600 的整数分钟', () => {
    expect(parseDuration('1')).toEqual({ ok: true, value: 1 });
    expect(parseDuration('90')).toEqual({ ok: true, value: 90 });
    expect(parseDuration('600')).toEqual({ ok: true, value: 600 });
    expect(parseDuration(' 090 ')).toEqual({ ok: true, value: 90 });
  });

  it('空值不当 30 分钟', () => {
    expect(parseDuration('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseDuration('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('非整数 / 掺字母 / 负号：format，不静默截断', () => {
    expect(parseDuration('60abc')).toEqual({ ok: false, reason: 'format' });
    expect(parseDuration('4.5')).toEqual({ ok: false, reason: 'format' });
    expect(parseDuration('-5')).toEqual({ ok: false, reason: 'format' });
    expect(parseDuration('1e3')).toEqual({ ok: false, reason: 'format' });
  });

  it('越界：0 和 601 都是 range', () => {
    expect(parseDuration('0')).toEqual({ ok: false, reason: 'range' });
    expect(parseDuration('601')).toEqual({ ok: false, reason: 'range' });
  });
});

describe('buildBundleSelections（U10 组合套餐落单载荷）', () => {
  const UNASSIGNED = '__unassigned__';
  const START = '2026-09-08T14:00:00-04:00';

  it('unitOverrides 与 quote 单元数一一对应，顺序不变', () => {
    const out = buildBundleSelections({
      bundleId: 'b1',
      expectedVersion: 3,
      startsAt: START,
      unitCount: 3,
      assignments: [
        { membershipId: 'staff-a', isRequest: false },
        { membershipId: UNASSIGNED, isRequest: false },
        { membershipId: 'staff-c', isRequest: true },
      ],
      unassignedId: UNASSIGNED,
    });

    expect(out).toHaveLength(1);
    const sel = out[0];
    expect(sel).toEqual({
      bundleId: 'b1',
      expectedVersion: 3,
      startsAt: START,
      unitOverrides: [
        { membershipId: 'staff-a', resourceId: null, isRequest: false },
        // 待分配池 → null，且强制清掉点钟标记
        { membershipId: null, resourceId: null, isRequest: false },
        { membershipId: 'staff-c', resourceId: null, isRequest: true },
      ],
    });
  });

  it('assignments 短于单元数：其余单元留待分配', () => {
    const out = buildBundleSelections({
      bundleId: 'b1',
      startsAt: START,
      unitCount: 2,
      assignments: [{ membershipId: 'staff-a', isRequest: true }],
      unassignedId: UNASSIGNED,
    });
    expect(out[0].unitOverrides).toEqual([
      { membershipId: 'staff-a', resourceId: null, isRequest: true },
      { membershipId: null, resourceId: null, isRequest: false },
    ]);
  });

  it('额外加项原样透传（金额留给服务端算）', () => {
    const out = buildBundleSelections({
      bundleId: 'b1',
      startsAt: START,
      unitCount: 2,
      assignments: [
        { membershipId: 'staff-a', isRequest: false },
        { membershipId: 'staff-b', isRequest: false },
      ],
      unassignedId: UNASSIGNED,
      extraAddons: [
        { ref: 'r1', attachToUnit: 'u:0', serviceId: 'addon-x', qty: 1 },
        { ref: 'r2', attachToUnit: 'u:1', serviceId: 'addon-y', qty: 3 },
      ],
    });
    expect(out[0].extraAddons).toEqual([
      { ref: 'r1', attachToUnit: 'u:0', serviceId: 'addon-x', qty: 1 },
      { ref: 'r2', attachToUnit: 'u:1', serviceId: 'addon-y', qty: 3 },
    ]);
  });

  it('无额外加项时不塞 extraAddons 键', () => {
    const out = buildBundleSelections({
      bundleId: 'b1', startsAt: START, unitCount: 1, assignments: [], unassignedId: UNASSIGNED,
    });
    expect('extraAddons' in out[0]).toBe(false);
  });

  it('未传 expectedVersion 时不塞该字段（避免落一个 undefined）', () => {
    const out = buildBundleSelections({
      bundleId: 'b1',
      startsAt: START,
      unitCount: 1,
      assignments: [],
      unassignedId: UNASSIGNED,
    });
    expect('expectedVersion' in out[0]).toBe(false);
  });

  it('买两份同一套餐 = 两次调用结果拼接（两个独立实例）', () => {
    const one = buildBundleSelections({
      bundleId: 'b1', startsAt: START, unitCount: 1,
      assignments: [{ membershipId: 'staff-a', isRequest: false }], unassignedId: UNASSIGNED,
    });
    const two = buildBundleSelections({
      bundleId: 'b1', startsAt: START, unitCount: 1,
      assignments: [{ membershipId: 'staff-b', isRequest: false }], unassignedId: UNASSIGNED,
    });
    const merged = [...one, ...two];
    expect(merged).toHaveLength(2);
    expect(merged.map((s) => s.unitOverrides[0].membershipId)).toEqual(['staff-a', 'staff-b']);
  });

  it('选了套餐即可不带散项：载荷可与 items:[] 并存（契约 refine 只要求两者之一非空）', () => {
    const bundleSelections = buildBundleSelections({
      bundleId: 'b1', startsAt: START, unitCount: 2,
      assignments: [
        { membershipId: 'staff-a', isRequest: false },
        { membershipId: 'staff-b', isRequest: false },
      ],
      unassignedId: UNASSIGNED,
    });
    const payload = { customerId: null, walkInName: 'Jane', items: [] as unknown[], bundleSelections };
    expect(payload.items).toHaveLength(0);
    expect(payload.bundleSelections).toHaveLength(1);
    expect(payload.bundleSelections[0].unitOverrides).toHaveLength(2);
  });
});
