import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '@heroui/react';
import {
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Plus,
  Rocket,
  Save,
  ShieldCheck,
  Store,
  UserRoundPlus,
  UsersRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import {
  useDeskSettingsQuery,
  useFinishSetup,
  useSaveBusinessHours,
  useSaveLocationProfile,
  useSaveService,
  useSaveStaffProfile,
} from '@/features/settings/api';
import type { DeskSettings } from '@/features/settings/types';

const fieldClass = 'h-11 text-sm';
const selectClass = 'h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className="text-sm font-semibold text-slate-800">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-5 text-slate-500">{hint}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label, description }: {
  checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 text-left"
    >
      <span>
        <span className="block text-sm font-semibold text-slate-900">{label}</span>
        {description && <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span>}
      </span>
      <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-teal-600' : 'bg-slate-300')}>
        <span className={cn('absolute top-1 size-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
      </span>
    </button>
  );
}

function SaveBar({ saving, onSave, permission, label = '保存并继续' }: { saving: boolean; onSave: () => void; permission: string; label?: string }) {
  return (
    <div className="flex justify-end border-t border-slate-100 pt-5">
      <GuardedButton permission={permission} onClick={onSave} isDisabled={saving} className="gap-2">
        <Save className="size-4" />
        {saving ? '正在保存…' : label}
      </GuardedButton>
    </div>
  );
}

function StepHeading({ eyebrow, title, description, badge = '开店必需' }: {
  eyebrow: string; title: string; description: string; badge?: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-teal-700">{eyebrow}</p>
        <Badge variant={badge === '开店必需' ? 'default' : 'secondary'}>{badge}</Badge>
      </div>
      <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>
    </div>
  );
}

const DAYS = [
  ['mon', '周一'], ['tue', '周二'], ['wed', '周三'], ['thu', '周四'],
  ['fri', '周五'], ['sat', '周六'], ['sun', '周日'],
] as const;

export function StoreStepForm({ onSaved }: { onSaved: () => void }) {
  const { data } = useDeskSettingsQuery();
  const saveProfile = useSaveLocationProfile();
  const saveHours = useSaveBusinessHours();
  const [form, setForm] = useState({
    name: '', businessType: 'mixed', phone: '', email: '', addressStreet: '', addressCity: '',
    addressState: '', addressZip: '', timezone: 'America/New_York', businessDayCutoff: '04:00',
  });
  const [hours, setHours] = useState<Record<string, { open: string; close: string } | null>>({});

  useEffect(() => {
    if (!data) return;
    const l = data.location;
    setForm({
      name: l.name ?? '', businessType: l.businessType ?? 'mixed', phone: l.phone ?? '', email: l.email ?? '',
      addressStreet: l.addressStreet ?? '', addressCity: l.addressCity ?? '', addressState: l.addressState ?? '',
      addressZip: l.addressZip ?? '', timezone: l.timezone ?? 'America/New_York', businessDayCutoff: l.businessDayCutoff ?? '04:00',
    });
    setHours(l.businessHours ?? {});
  }, [data]);

  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    if (!form.name.trim() || !form.timezone.trim()) {
      toast.danger('请先填写店名并确认时区');
      return;
    }
    if (!Object.values(hours).some(Boolean)) {
      toast.danger('请至少设置一个营业日');
      return;
    }
    try {
      await saveProfile.mutateAsync({
        name: form.name.trim(), businessType: form.businessType as any, phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined, addressStreet: form.addressStreet.trim(), addressCity: form.addressCity.trim(),
        addressState: form.addressState.trim(), addressZip: form.addressZip.trim(), timezone: form.timezone,
        businessDayCutoff: form.businessDayCutoff,
      });
      await saveHours.mutateAsync({ hours });
      toast.success('门店资料与营业时间已保存');
      onSaved();
    } catch (error) {
      toast.danger(`保存失败：${error instanceof Error ? error.message : 'UNKNOWN'}`);
    }
  };

  return (
    <div className="space-y-6">
      <StepHeading eyebrow="第 1 步" title="确认门店资料" description="时区和营业时间会直接影响预约、通知、报表与日结，请务必亲眼确认。" />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="店铺名称"><Input className={fieldClass} value={form.name} onChange={(e) => update('name', e.target.value)} /></Field>
        <Field label="主营行业">
          <select className={selectClass} value={form.businessType} onChange={(e) => update('businessType', e.target.value)}>
            <option value="nail">美甲 Nail</option><option value="massage">按摩 Massage</option>
            <option value="foot_spa">足疗 Foot Spa</option><option value="lash">美睫 Lash</option>
            <option value="scalp">头疗 Scalp</option><option value="hair">美发 Hair</option><option value="mixed">综合 Mixed</option>
          </select>
        </Field>
        <Field label="联系电话"><Input className={fieldClass} value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="+12125551234" /></Field>
        <Field label="联系邮箱"><Input className={fieldClass} type="email" value={form.email} onChange={(e) => update('email', e.target.value)} /></Field>
        <Field label="街道地址"><Input className={fieldClass} value={form.addressStreet} onChange={(e) => update('addressStreet', e.target.value)} /></Field>
        <div className="grid grid-cols-[1fr_80px_100px] gap-2">
          <Field label="城市"><Input className={fieldClass} value={form.addressCity} onChange={(e) => update('addressCity', e.target.value)} /></Field>
          <Field label="州"><Input className={fieldClass} value={form.addressState} onChange={(e) => update('addressState', e.target.value.toUpperCase())} /></Field>
          <Field label="邮编"><Input className={fieldClass} value={form.addressZip} onChange={(e) => update('addressZip', e.target.value)} /></Field>
        </div>
        <Field label="门店时区" hint="不要直接相信浏览器猜测；VPN 或跨州管理时可能不正确。">
          <select className={selectClass} value={form.timezone} onChange={(e) => update('timezone', e.target.value)}>
            <option value="America/New_York">美国东部</option><option value="America/Chicago">美国中部</option>
            <option value="America/Denver">美国山区</option><option value="America/Phoenix">亚利桑那</option>
            <option value="America/Los_Angeles">美国西部</option><option value="America/Anchorage">阿拉斯加</option>
            <option value="Pacific/Honolulu">夏威夷</option>
          </select>
        </Field>
        <Field label="营业日截止时间" hint="凌晨营业的店可设为 03:00 或 04:00。"><Input className={fieldClass} type="time" value={form.businessDayCutoff} onChange={(e) => update('businessDayCutoff', e.target.value)} /></Field>
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-bold text-slate-900">每周营业时间</h3>
          <Button variant="ghost" size="sm" onClick={() => {
            const monday = hours.mon ?? { open: '09:00', close: '20:00' };
            setHours(Object.fromEntries(DAYS.map(([key]) => [key, monday])));
          }}>七天使用周一时间</Button>
        </div>
        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
          {DAYS.map(([key, label]) => {
            const value = hours[key] ?? null;
            return (
              <div key={key} className="grid grid-cols-[70px_70px_1fr] items-center gap-3 px-4 py-3 sm:grid-cols-[80px_90px_1fr]">
                <span className="text-sm font-semibold text-slate-800">{label}</span>
                <button type="button" onClick={() => setHours((h) => ({ ...h, [key]: value ? null : { open: '09:00', close: '20:00' } }))} className={cn('text-left text-xs font-semibold', value ? 'text-teal-700' : 'text-slate-400')}>{value ? '营业' : '休息'}</button>
                {value ? <div className="flex items-center gap-2"><Input type="time" className="h-9 text-sm" value={value.open} onChange={(e) => setHours((h) => ({ ...h, [key]: { ...value, open: e.target.value } }))} /><span className="text-slate-400">—</span><Input type="time" className="h-9 text-sm" value={value.close} onChange={(e) => setHours((h) => ({ ...h, [key]: { ...value, close: e.target.value } }))} /></div> : <span className="text-sm text-slate-400">当天不接受预约</span>}
              </div>
            );
          })}
        </div>
      </div>
      <SaveBar permission="settings.manage" saving={saveProfile.isPending || saveHours.isPending} onSave={save} />
    </div>
  );
}

export function CatalogStepForm({ onSaved }: { onSaved: () => void }) {
  const { data } = useDeskSettingsQuery();
  const saveService = useSaveService();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState('60');
  const active = data?.services.filter((service) => service.active) ?? [];

  const add = async () => {
    const priceMatch = price.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
    const priceCents = priceMatch
      ? Number.parseInt(priceMatch[1]!, 10) * 100 + Number.parseInt((priceMatch[2] ?? '').padEnd(2, '0') || '0', 10)
      : null;
    const durationValue = Number.parseInt(duration, 10);
    if (!name.trim() || priceCents === null || !Number.isFinite(durationValue) || durationValue < 5) {
      toast.danger('请填写项目名称、正确价格和时长'); return;
    }
    try {
      const displayName = name.trim();
      await saveService.mutateAsync({
        name: { en: displayName, 'zh-Hans': displayName },
        basePriceCents: priceCents,
        durationMin: durationValue,
        active: true,
      });
      setName(''); setPrice('');
      toast.success('项目已加入项目库');
      onSaved();
    } catch (error) { toast.danger(`添加失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
  };

  return (
    <div className="space-y-6">
      <StepHeading eyebrow="第 2 步" title="设置项目与价格" description="先建立最常用的项目，之后可以在系统设置中继续补分类、技能和加项。" />
      <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-5 md:grid-cols-[1.4fr_.7fr_.7fr_auto]">
        <Field label="项目名称"><Input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：60 分钟足底按摩" /></Field>
        <Field label="价格（美元）"><Input className={fieldClass} type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="65.00" /></Field>
        <Field label="时长（分钟）"><Input className={fieldClass} type="number" min="5" step="5" value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        <GuardedButton permission="catalog.manage" onClick={add} isDisabled={saveService.isPending} className="h-11 self-end gap-2"><Plus className="size-4" />添加项目</GuardedButton>
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-900">当前项目</h3><Badge variant={active.length ? 'success' : 'warning'}>{active.length} 个启用</Badge></div>
        {active.length ? <div className="grid gap-3 sm:grid-cols-2">{active.map((service) => <div key={service.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-4"><div><p className="font-semibold text-slate-900">{service.displayName}</p><p className="mt-1 text-xs text-slate-500">{service.durationMin} 分钟 · ${(service.basePriceCents / 100).toFixed(2)}</p></div>{service.onlineBookable && <Badge>可网约</Badge>}</div>)}</div> : <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-6 text-center text-sm text-amber-900">至少添加一个项目才能正式开店。</div>}
      </div>
    </div>
  );
}

export function TeamStepForm({ onSaved }: { onSaved: () => void }) {
  const { data } = useDeskSettingsQuery();
  const saveStaff = useSaveStaffProfile();
  const [name, setName] = useState('');
  const [bookable, setBookable] = useState(true);
  const [rotation, setRotation] = useState(true);
  const add = async () => {
    if (!name.trim()) { toast.danger('请填写员工姓名'); return; }
    try {
      await saveStaff.mutateAsync({ name: name.trim(), isBookable: bookable, inRotation: rotation, maxConcurrentAppointments: 1 });
      setName(''); toast.success('员工已添加'); onSaved();
    } catch (error) { toast.danger(`添加失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
  };
  const staff = data?.staff ?? [];
  return (
    <div className="space-y-6">
      <StepHeading eyebrow="第 3 步" title="添加员工与排班" description="先把会接客的人加进来。员工账号、详细班表、技能和房间可以稍后继续完善。" />
      <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-5 md:grid-cols-2">
        <Field label="员工姓名"><Input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Amy" /></Field>
        <div className="flex items-end"><GuardedButton permission="staff.manage" onClick={add} isDisabled={saveStaff.isPending} className="h-11 w-full gap-2"><UserRoundPlus className="size-4" />添加员工</GuardedButton></div>
        <Toggle checked={bookable} onChange={setBookable} label="可以被安排服务" description="前台员工不接客时请关闭。" />
        <Toggle checked={rotation} onChange={setRotation} label="参加 Walk-in 轮牌" description="店长只接点钟、不吃轮牌时请关闭。" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{staff.map((member) => <div key={member.membershipId} className="flex items-center gap-3 rounded-xl border border-slate-200 p-4"><span className="grid size-10 place-items-center rounded-full bg-teal-50 font-bold text-teal-700">{member.name.slice(0, 1)}</span><div className="min-w-0 flex-1"><p className="truncate font-semibold text-slate-900">{member.name}</p><p className="text-xs text-slate-500">{member.isBookable ? '可接单' : '不接单'} · {member.inRotation ? '参加轮牌' : '不参加轮牌'}</p></div>{member.hasAccount ? <Badge variant="success">已上机</Badge> : <Badge variant="secondary">待上机</Badge>}</div>)}</div>
      {!staff.some((member) => member.isBookable) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">至少需要一位“可接单”员工。</div>}
      <div className="rounded-xl border border-teal-100 bg-teal-50/60 p-4 text-sm leading-6 text-teal-900">
        开店后可以在后台继续维护员工账号、详细班表、技能与房间；当前页面只收集正式开店所必需的信息。
      </div>
    </div>
  );
}

function launchChecks(settings: DeskSettings | undefined) {
  if (!settings) return [];
  return [
    { label: '门店资料和时区已确认', ok: Boolean(settings.location.profileConfirmedAt) },
    { label: '至少设置一个营业日', ok: Object.values(settings.location.businessHours ?? {}).some(Boolean) },
    { label: '至少有一个启用项目', ok: settings.services.some((service) => service.active) },
    { label: '至少有一位可接单员工', ok: settings.staff.some((staff) => staff.isBookable) },
  ];
}

export function LaunchStep({ onGoToStep }: { onGoToStep: (step: 'store' | 'catalog' | 'team') => void }) {
  const navigate = useNavigate();
  const { data, refetch, isFetching } = useDeskSettingsQuery();
  const finish = useFinishSetup();
  const checks = useMemo(() => launchChecks(data), [data]);
  const ready = checks.length > 0 && checks.every((check) => check.ok);
  const launch = async () => {
    try {
      await refetch();
      await finish.mutateAsync();
      toast.success('门店已正式开通');
      // 只有服务端把 locations.status 改为 active 后，才允许离开 setup。
      navigate('/dashboard', { replace: true });
    }
    catch (error) { toast.danger(`开店失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
  };
  return (
    <div className="space-y-6">
      <StepHeading eyebrow="第 4 步" title="测试并正式开店" description="系统先检查真正的数据。正式开店不会要求 POS 机器、AI 电话或品牌主页。" />
      <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
        {checks.map((check) => <div key={check.label} className="flex items-center justify-between gap-3 px-5 py-4"><div className="flex items-center gap-3">{check.ok ? <CheckCircle2 className="size-5 text-emerald-600" /> : <Clock3 className="size-5 text-amber-500" />}<span className="text-sm font-semibold text-slate-800">{check.label}</span></div><Badge variant={check.ok ? 'success' : 'warning'}>{check.ok ? '已完成' : '待完成'}</Badge></div>)}
      </div>
      {!ready && <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => onGoToStep('store')}><Store className="size-4" />门店资料</Button><Button variant="outline" onClick={() => onGoToStep('catalog')}><CircleDollarSign className="size-4" />项目价格</Button><Button variant="outline" onClick={() => onGoToStep('team')}><UsersRound className="size-4" />员工排班</Button></div>}
      <div className="rounded-2xl border border-teal-100 bg-teal-50/60 p-5">
        <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-teal-700" /><div><h3 className="font-bold text-teal-950">建议做一次 3 分钟试营业</h3><ol className="mt-2 space-y-1 text-sm leading-6 text-teal-900"><li>1. 创建一笔测试预约，确认出现在日程。</li><li>2. 模拟签到、开始服务和完成服务。</li><li>3. 用现金方式模拟结账，确认订单和日结数字。</li></ol></div></div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <p className="text-xs leading-5 text-slate-500 sm:mr-auto">开店后可在后台创建测试预约，验证完整服务链路。</p>
        <GuardedButton permission="settings.manage" onClick={launch} isDisabled={!ready || finish.isPending || isFetching} className="gap-2"><Rocket className="size-4" />{finish.isPending ? '正在开通…' : '正式开店'}</GuardedButton>
      </div>
    </div>
  );
}
