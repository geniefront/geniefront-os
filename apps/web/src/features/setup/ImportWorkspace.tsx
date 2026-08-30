import { useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@heroui/react';
import { Camera, CheckCircle2, Globe2, MapPinned, Search, ShieldCheck, Star, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiGet, apiPost, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useLanguage } from '@/LanguageContext';
import { settingsKeys } from '@/features/settings/api';
import { cn } from '@/lib/utils';

type Hours = Record<string, { open: string; close: string } | null>;
interface BusinessResult {
  yelpBusinessId?: string;
  googlePlaceId?: string;
  name: string;
  phoneE164: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; state: string | null; zip: string | null; country: string | null; display: string[] };
  businessHours: Hours;
  timezone?: string;
  timezoneConfidence?: string;
  rating: number | null;
  reviewCount: number | null;
  isClosed: boolean;
}
interface BlueprintItem {
  itemId: string;
  displayName: string;
  displayLocale: string;
  name: Record<string, string>;
  category: string | null;
  durationMin: number | null;
  priceCents: number | null;
  confidenceBp: number;
  lowConfidence: boolean;
  kind: string;
}
interface StaffProposal { name: string; role: string }
interface LocationProposal {
  name?: string;
  phone?: string;
  email?: string;
  addressStreet?: string;
  addressCity?: string;
  addressState?: string;
  addressZip?: string;
  businessType?: string;
  businessHours?: Hours;
  socialLinks?: string[];
  staff?: StaffProposal[];
}
interface BlueprintView {
  blueprintId: string;
  label: string | null;
  locationProposal: LocationProposal;
  items: BlueprintItem[];
  unresolved: Array<{ field: string; question: string }>;
}

const SOURCES = [
  { id: 'google', name: 'Google', icon: MapPinned, tone: 'text-blue-700 bg-blue-50 border-blue-200' },
  { id: 'yelp', name: 'Yelp', icon: Star, tone: 'text-red-700 bg-red-50 border-red-200' },
  { id: 'website', name: '扫描官网', icon: Globe2, tone: 'text-violet-700 bg-violet-50 border-violet-200' },
  { id: 'menu', name: '扫描价目表', icon: Camera, tone: 'text-amber-700 bg-amber-50 border-amber-200' },
] as const;

async function imagePayload(file: File, seq: number) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
  const max = 2576;
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.round(image.naturalWidth * scale);
  const height = Math.round(image.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
  const mediaType = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
  const encoded = canvas.toDataURL(mediaType as 'image/png' | 'image/webp' | 'image/jpeg', 0.92);
  return { seq, base64: encoded.split(',')[1], mediaType, widthPx: width, heightPx: height };
}

function CheckBox({ checked }: { checked: boolean }) {
  return <span className={cn('grid size-6 shrink-0 place-items-center rounded-md border', checked ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300')}>{checked && <CheckCircle2 className="size-4" />}</span>;
}

export function ImportWorkspace({ onContinue }: { onContinue: () => void }) {
  const { membershipId } = useSession();
  const { language } = useLanguage();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<(typeof SOURCES)[number]['id']>('google');
  const [name, setName] = useState('');
  const [place, setPlace] = useState('');
  const [url, setUrl] = useState('');
  const [businesses, setBusinesses] = useState<BusinessResult[]>([]);
  const [pendingBusiness, setPendingBusiness] = useState<BusinessResult | null>(null);
  const [businessFields, setBusinessFields] = useState<Set<string>>(new Set());
  const [blueprint, setBlueprint] = useState<BlueprintView | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [acceptedStaff, setAcceptedStaff] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = <T,>(setter: (value: Set<T>) => void, current: Set<T>, key: T) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };
  const loadBlueprint = (view: BlueprintView) => {
    setBlueprint(view);
    setAccepted(new Set(view.items.filter((item) => !item.lowConfidence && ['service', 'addon'].includes(item.kind)).map((item) => item.itemId)));
    setAcceptedStaff(new Set());
  };
  const search = async () => {
    if (name.trim().length < 2 || place.trim().length < 3) { toast.danger('请填写店名和邮编或城市'); return; }
    setBusy(true);
    try {
      const out = await apiGet<{ businesses: BusinessResult[] }>(`/v1/desk/${source}/search?term=${encodeURIComponent(name.trim())}&location=${encodeURIComponent(place.trim())}`);
      setBusinesses(out.businesses);
      if (!out.businesses.length) toast.warning('没有找到匹配门店，请换一个店名或地点');
    } catch (error) { toast.danger(`搜索失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
    finally { setBusy(false); }
  };
  const chooseBusiness = async (item: BusinessResult) => {
    setBusy(true);
    try {
      const provider = source as 'google' | 'yelp';
      const id = provider === 'google' ? item.googlePlaceId! : item.yelpBusinessId!;
      const { business } = await apiGet<{ business: BusinessResult }>(`/v1/desk/${provider}/search?id=${encodeURIComponent(id)}`);
      setPendingBusiness(business);
      setBusinessFields(new Set(['name', 'phone', 'address', 'businessHours', 'rating']));
    } catch (error) { toast.danger(`读取门店资料失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
    finally { setBusy(false); }
  };
  const applyBusiness = async () => {
    if (!membershipId || !pendingBusiness) return;
    setBusy(true);
    try {
      const provider = source as 'google' | 'yelp';
      const business = pendingBusiness;
      await runCommand(provider === 'google' ? 'location.applyGoogle' : 'location.applyYelp', {
        ...(provider === 'google' ? { googlePlaceId: business.googlePlaceId } : { yelpBusinessId: business.yelpBusinessId }),
        ...(businessFields.has('name') ? { name: business.name } : {}),
        ...(businessFields.has('phone') && business.phoneE164 ? { phone: business.phoneE164 } : {}),
        ...(businessFields.has('address') ? { address: business.address } : {}),
        ...(businessFields.has('businessHours') ? { businessHours: business.businessHours } : {}),
        ...(provider === 'yelp' && businessFields.has('businessHours') && business.timezoneConfidence === 'high' ? { timezone: business.timezone } : {}),
        ...(businessFields.has('rating') ? { ratingBp: business.rating === null ? null : Math.round(business.rating * 10000), reviewCount: business.reviewCount } : {}),
      }, membershipId);
      await queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
      toast.success('选中的公开门店资料已导入，请继续确认');
      setPendingBusiness(null);
      onContinue();
    } catch (error) { toast.danger(`导入失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
    finally { setBusy(false); }
  };
  const scanWebsite = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try { loadBlueprint(await apiPost<BlueprintView>('/v1/onboarding/website/extract', { url: url.trim(), locale: language })); }
    catch (error) { toast.danger(`官网扫描失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
    finally { setBusy(false); }
  };
  const scanImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].slice(0, 6);
    if (!files.length || !membershipId) return;
    setBusy(true);
    try {
      const images = await Promise.all(files.map(imagePayload));
      const created = await runCommand<{ blueprintId: string }>('blueprint.createDraft', {
        label: `价目表 · ${new Date().toLocaleDateString()}`,
        sources: images.map((image) => ({ seq: image.seq, kind: 'price_list_image', storagePath: null, widthPx: image.widthPx, heightPx: image.heightPx })),
      }, membershipId);
      await apiPost(`/v1/blueprint/${created.result.blueprintId}/extract`, { images, locale: language });
      loadBlueprint(await apiGet<BlueprintView>(`/v1/desk/blueprint/${created.result.blueprintId}`));
    } catch (error) { toast.danger(`价目表识别失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
    finally { setBusy(false); event.target.value = ''; }
  };
  const applyBlueprint = async () => {
    if (!blueprint || !membershipId) return;
    setBusy(true);
    try {
      if (blueprint.items.length > 0) {
        await runCommand('blueprint.reviewItems', {
          blueprintId: blueprint.blueprintId,
          items: blueprint.items.map((item) => ({ itemId: item.itemId, decision: accepted.has(item.itemId) ? 'accepted' : 'rejected' })),
        }, membershipId);
      }
      const proposal = blueprint.locationProposal ?? {};
      const applyLocationProposal = Boolean(
        [proposal.name, proposal.phone, proposal.email, proposal.addressStreet, proposal.addressCity,
          proposal.addressState, proposal.addressZip, proposal.businessType].some((value) => value?.trim())
        || Object.keys(proposal.businessHours ?? {}).length > 0,
      );
      await runCommand('blueprint.apply', {
        blueprintId: blueprint.blueprintId,
        fallbackDurationMin: 45,
        applyLocationProposal,
        staffProposalIndexes: [...acceptedStaff],
        allowNoServices: accepted.size === 0,
      }, membershipId);
      await queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
      toast.success(`已建立 ${accepted.size} 个项目、${acceptedStaff.size} 位员工`);
      setBlueprint(null);
      onContinue();
    } catch (error) { toast.danger(`草案落地失败：${error instanceof Error ? error.message : 'UNKNOWN'}`); }
    finally { setBusy(false); }
  };

  if (pendingBusiness) {
    const fields = [
      { id: 'name', label: '店名', value: pendingBusiness.name },
      { id: 'phone', label: '电话', value: pendingBusiness.phoneE164 || '未提供' },
      { id: 'address', label: '地址', value: pendingBusiness.address.display.join(', ') || '未提供' },
      { id: 'businessHours', label: '营业时间', value: `${Object.values(pendingBusiness.businessHours).filter(Boolean).length} 个营业日` },
      { id: 'rating', label: '评分记录', value: pendingBusiness.rating === null ? '未提供' : `${pendingBusiness.rating} ★ · ${pendingBusiness.reviewCount ?? 0} 条` },
    ];
    return <div className="space-y-5">
      <div><p className="text-sm font-semibold text-teal-700">公开资料预览</p><h2 className="mt-1 text-2xl font-bold text-slate-950">选择要导入的字段</h2><p className="mt-2 text-sm text-slate-600">不勾选的内容不会覆盖店铺当前资料。</p></div>
      <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">{fields.map((field) => <button key={field.id} type="button" onClick={() => toggle(setBusinessFields, businessFields, field.id)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-slate-50"><CheckBox checked={businessFields.has(field.id)} /><span className="w-24 text-sm font-semibold text-slate-800">{field.label}</span><span className="min-w-0 flex-1 truncate text-sm text-slate-500">{field.value}</span></button>)}</div>
      {pendingBusiness.isClosed && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">平台把这家店标记为已永久关闭，请确认是否选错门店。</div>}
      <div className="flex justify-between"><Button variant="ghost" onClick={() => setPendingBusiness(null)}>返回搜索</Button><Button onClick={applyBusiness} isDisabled={busy || businessFields.size === 0}>{busy ? '正在导入…' : `导入 ${businessFields.size} 项资料`}</Button></div>
    </div>;
  }

  if (blueprint) {
    const proposal = blueprint.locationProposal ?? {};
    const locationSummary = [proposal.name, proposal.phone, proposal.email, proposal.addressStreet, proposal.addressCity, proposal.addressState, proposal.addressZip].filter(Boolean).join(' · ');
    const hasLocation = Boolean(locationSummary || Object.keys(proposal.businessHours ?? {}).length);
    const canApply = accepted.size > 0 || acceptedStaff.size > 0 || hasLocation;
    return <div className="space-y-5">
      <div><p className="text-sm font-semibold text-teal-700">导入草案</p><h2 className="mt-1 text-2xl font-bold text-slate-950">逐项确认 {blueprint.label}</h2><p className="mt-2 text-sm text-slate-600">低置信度项目默认不勾选；确认后才会进入正式数据。</p></div>
      {hasLocation && <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-4"><p className="font-semibold text-violet-950">门店资料</p><p className="mt-1 text-sm leading-6 text-violet-800">{locationSummary || '已识别营业时间'}。确认后会写入门店资料，下一步仍可修改。</p></div>}
      {blueprint.items.length > 0 && <div><p className="mb-2 text-sm font-bold text-slate-800">项目与价格</p><div className="max-h-[360px] divide-y divide-slate-100 overflow-auto rounded-2xl border border-slate-200">{blueprint.items.map((item) => <button key={item.itemId} type="button" onClick={() => toggle(setAccepted, accepted, item.itemId)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-slate-50"><CheckBox checked={accepted.has(item.itemId)} /><div className="min-w-0 flex-1"><p className="font-semibold text-slate-900">{item.displayName}</p><p className="text-xs text-slate-500">{item.category || '未分类'} · {item.durationMin ?? 45} 分钟 · {item.priceCents === null ? '价格待确认' : `$${(item.priceCents / 100).toFixed(2)}`}</p></div>{item.lowConfidence && <Badge variant="warning">请核对</Badge>}</button>)}</div></div>}
      {(proposal.staff?.length ?? 0) > 0 && <div><p className="mb-2 text-sm font-bold text-slate-800">官网员工（默认不导入）</p><div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">{proposal.staff!.map((staff, index) => <button key={`${staff.name}-${index}`} type="button" onClick={() => toggle(setAcceptedStaff, acceptedStaff, index)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-slate-50"><CheckBox checked={acceptedStaff.has(index)} /><div><p className="font-semibold text-slate-900">{staff.name}</p><p className="text-xs text-slate-500">{staff.role || '职位待补充'}</p></div></button>)}</div></div>}
      {blueprint.unresolved.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{blueprint.unresolved.map((question) => <p key={question.question}>• {question.question}</p>)}</div>}
      <div className="flex justify-between"><Button variant="ghost" onClick={() => setBlueprint(null)}>返回</Button><Button onClick={applyBlueprint} isDisabled={busy || !canApply}>{busy ? '正在建立…' : `确认导入（${accepted.size} 个项目，${acceptedStaff.size} 位员工）`}</Button></div>
    </div>;
  }

  return <div className="space-y-6">
    <div><p className="text-sm font-semibold text-teal-700">第 1 步 · 可跳过</p><h2 className="mt-1 text-2xl font-bold text-slate-950">把现有店铺资料带进来</h2><p className="mt-2 text-sm leading-6 text-slate-600">公开资料和 AI 结果都会先给你确认，再写入正式门店和项目库。</p></div>
    <div className="grid gap-3 md:grid-cols-2">{SOURCES.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" onClick={() => { setSource(item.id); setBusinesses([]); }} className={cn('rounded-2xl border p-4 text-left', source === item.id ? 'border-teal-500 bg-teal-50/60' : 'border-slate-200')}><span className={cn('grid size-10 place-items-center rounded-xl border', item.tone)}><Icon className="size-5" /></span><p className="mt-3 font-bold text-slate-900">{item.name}</p></button>; })}</div>
    {source === 'google' || source === 'yelp' ? <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-5"><div className="grid gap-3 sm:grid-cols-[1fr_180px_auto]"><Input className="h-11 text-sm" value={name} onChange={(event) => setName(event.target.value)} placeholder="店名" /><Input className="h-11 text-sm" value={place} onChange={(event) => setPlace(event.target.value)} placeholder="邮编或城市" /><Button onClick={search} isDisabled={busy}><Search className="size-4" />{busy ? '搜索中…' : '搜索'}</Button></div>{businesses.map((business) => <button key={business.googlePlaceId ?? business.yelpBusinessId} type="button" onClick={() => void chooseBusiness(business)} className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-teal-400"><div><p className="font-semibold">{business.name}</p><p className="text-xs text-slate-500">{business.address.display.join(', ')} · {business.rating ?? '—'} ★</p></div><Badge variant={business.isClosed ? 'error' : 'outline'}>{business.isClosed ? '已关闭' : '选择'}</Badge></button>)}</div>
      : source === 'website' ? <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-5 sm:flex-row"><Input className="h-11 flex-1 text-sm" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://你的官网.com" /><Button onClick={scanWebsite} isDisabled={busy}><Globe2 className="size-4" />{busy ? '扫描中…' : '扫描官网'}</Button></div>
        : <label className="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50/50 p-8 text-center"><Upload className="size-7 text-amber-700" /><span className="mt-3 font-bold text-slate-900">选择最多 6 张价目表照片</span><span className="mt-1 text-xs text-slate-500">JPEG、PNG 或 WebP；大图会在浏览器缩到 2576px</span><input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={scanImages} disabled={busy} /></label>}
    <div className="flex items-start gap-3 rounded-xl border border-teal-100 bg-teal-50/50 p-4 text-sm text-teal-900"><ShieldCheck className="size-5 shrink-0" />官网抓取会阻止内网地址和危险跳转；任何来源都不会绕过人工确认。</div>
  </div>;
}
