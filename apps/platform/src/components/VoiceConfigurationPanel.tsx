import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { voiceConfigurationSchema, type VoiceConfiguration, type VoiceConfigurationPanel as Panel } from '@gf/contracts';
import { ApiError, platformGet } from '@/lib/api';
import { useIdempotentSend } from '@/lib/idempotency';

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-500/30';
const queryKey = (locationId: string) => ['platform', 'store-voice-configuration', locationId];

export function VoiceConfigurationPanel({ locationId }: { locationId: string }) {
  const query = useQuery({
    queryKey: queryKey(locationId),
    queryFn: () => platformGet<Panel>(`/v1/platform/stores/${locationId}/voice-configuration`),
    refetchOnWindowFocus: false,
  });
  return <section id="voice-configuration" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
    <div><h2 className="text-lg font-semibold">AI 应答与通话通知 / AI voice configuration</h2>
      <p className="mt-1 text-sm text-slate-500">在此维护客户工作台显示的配置。客户仅可查看，并通过工单申请修改。</p>
    </div>
    {query.isPending ? <p className="text-sm text-slate-500">Loading…</p>
      : query.isError ? <div role="alert" className="space-y-2 text-sm text-red-700"><p>无法加载语音配置，请重试。</p><button type="button" onClick={() => void query.refetch()} className="underline">重新加载 / Retry</button></div>
      : <VoiceConfigurationEditor key={locationId} locationId={locationId} initial={query.data} />}
  </section>;
}

function VoiceConfigurationEditor({ locationId, initial }: { locationId: string; initial: Panel }) {
  const send = useIdempotentSend();
  const qc = useQueryClient();
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState<VoiceConfiguration>({ phoneAssistant: initial.phoneAssistant, voiceNotifications: initial.voiceNotifications });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [reloading, setReloading] = useState(false);
  const lock = useRef(false);
  const mutation = useMutation({
    mutationFn: (value: VoiceConfiguration) => send('PUT', `/v1/platform/stores/${locationId}/voice-configuration`, { ...value, expectedRevision: base.revision }) as Promise<Panel>,
  });
  const busy = mutation.isPending || reloading;
  const dirty = JSON.stringify(draft) !== JSON.stringify({ phoneAssistant: base.phoneAssistant, voiceNotifications: base.voiceNotifications });
  function response<K extends keyof VoiceConfiguration['phoneAssistant']>(field: K, value: VoiceConfiguration['phoneAssistant'][K]) {
    setDraft(old => ({ ...old, phoneAssistant: { ...old.phoneAssistant, [field]: value } }));
    setMessage(''); if (!stale) setError('');
  }
  function recipient(field: 'email' | 'phone', value: string) {
    setDraft(old => ({ ...old, voiceNotifications: { ...old.voiceNotifications, [field]: value || null } }));
    setMessage(''); if (!stale) setError('');
  }
  function accept(value: Panel) {
    setBase(value); setDraft({ phoneAssistant: value.phoneAssistant, voiceNotifications: value.voiceNotifications });
    qc.setQueryData(queryKey(locationId), value);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || stale || !dirty) return;
    const parsed = voiceConfigurationSchema.safeParse(draft);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.');
      setError(field?.endsWith('phone') ? '短信号码请使用国际格式，例如 +16676606667。' : field?.endsWith('email') ? '请输入有效邮箱，或留空关闭邮件通知。' : '请检查输入内容，开场白最多 4000 字。');
      return;
    }
    lock.current = true; setError(''); setMessage('');
    try {
      const result = await mutation.mutateAsync(parsed.data);
      accept(result);
      setMessage('已保存。客户刷新语音设置页后会看到更新内容。');
    } catch (err) {
      const conflict = err instanceof ApiError && err.details.reason === 'stale_voice_configuration';
      setStale(conflict);
      setError(conflict ? '配置已被其他人修改。请重新加载并核对后保存，当前输入已保留。' : '保存失败，输入已保留，请重试。');
    } finally { lock.current = false; }
  }
  async function reload() {
    setReloading(true);
    try {
      const value = await platformGet<Panel>(`/v1/platform/stores/${locationId}/voice-configuration`);
      accept(value); setStale(false); setError(''); setMessage('已加载最新配置。');
    } catch { setError('重新加载失败，当前输入已保留。'); }
    finally { setReloading(false); }
  }
  return <form onSubmit={event => void save(event)} className="space-y-6">
    <fieldset disabled={busy} className="space-y-4">
      <legend className="mb-3 font-medium text-slate-900">AI 应答配置</legend>
      <p className="text-sm leading-6 text-slate-500">以下四项用于客户展示与运营记录；保存不会自动更改电话供应商的实际应答配置。请在供应商端配置完成后同步这里。</p>
      <label className="block space-y-1.5 text-sm font-medium">开场白<textarea className={inputClass} rows={3} maxLength={4000} value={draft.phoneAssistant.greetingPrompt} onChange={e => response('greetingPrompt', e.target.value)} /></label>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="block space-y-1.5 text-sm font-medium">语音风格<select className={inputClass} value={draft.phoneAssistant.voiceTone ?? ''} onChange={e => response('voiceTone', (e.target.value || null) as VoiceConfiguration['phoneAssistant']['voiceTone'])}><option value="">未配置</option><option value="warm">温和热情</option><option value="professional">专业稳重</option><option value="concise">简洁高效</option></select></label>
        {(['autoBookEnabled', 'afterHoursVoicemail'] as const).map(field => <label key={field} className="block space-y-1.5 text-sm font-medium">{field === 'autoBookEnabled' ? '自动预约' : '非营业时间语音留言'}<select className={inputClass} value={draft.phoneAssistant[field] == null ? '' : String(draft.phoneAssistant[field])} onChange={e => response(field, e.target.value === '' ? null : e.target.value === 'true')}><option value="">未配置</option><option value="true">已开启</option><option value="false">已关闭</option></select></label>)}
      </div>
    </fieldset>
    <fieldset disabled={busy} className="space-y-4 border-t border-slate-100 pt-5">
      <legend className="font-medium text-slate-900">通话摘要收件人</legend>
      <p className="text-sm leading-6 text-slate-500">收件人保存后会用于实际通话摘要及相关预约通知。留空关闭对应渠道，不会更改客户登录邮箱、门店公开电话或人工转接号码。</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm font-medium">邮件<input className={inputClass} type="email" maxLength={320} value={draft.voiceNotifications.email ?? ''} onChange={e => recipient('email', e.target.value)} /></label>
        <label className="block space-y-1.5 text-sm font-medium">短信<input className={inputClass} type="tel" maxLength={24} placeholder="+16676606667" value={draft.voiceNotifications.phone ?? ''} onChange={e => recipient('phone', e.target.value)} /><span className="block text-xs font-normal text-slate-500">国际格式，含国家代码，例如 +16676606667。</span></label>
      </div>
    </fieldset>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="text-sm text-teal-700">{message}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      {stale && <button type="button" disabled={busy} onClick={() => void reload()} className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50">重新加载（替换当前输入）</button>}
      <button type="submit" disabled={busy || stale || !dirty} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '保存中…' : '保存并更新客户展示'}</button>
    </div>
  </form>;
}
