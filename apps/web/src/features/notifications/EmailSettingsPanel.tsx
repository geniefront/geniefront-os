import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {toast} from '@heroui/react';
import {apiGet,runCommand} from '@/lib/api';
import {useSession} from '@/lib/session';
import {useLanguage} from '@/LanguageContext';
import {useErrorMessage} from '@/lib/errorMessage';

type Panel={account:{account_email:string;status:string}|null;defaultSender:string|null;
 settings:{use_custom:boolean;domain_request_id:string|null;from_local:string;reply_to:string|null}|null;
 domains:Array<{id:string;domain:string;status:string;note:string;last_error:string|null;dns_records:Array<{type:string;name:string;value:string;action:string;required:boolean}>}>;
 validation:Array<{email:string;result:string;reason:string;checked_at:string}>;
 messages:Array<{id:string;to_email:string;subject:string;status:string;delivery_state:string|null;last_error:string|null}>;};
export function EmailSettingsPanel(){
 const {t}=useLanguage(),{membershipId}=useSession(),queryClient=useQueryClient(),errorMessage=useErrorMessage();
 const [domain,setDomain]=useState(''),[managedBy,setManagedBy]=useState('platform'),[replyTo,setReplyTo]=useState(''),[emails,setEmails]=useState(''),[busy,setBusy]=useState(false);
 const q=useQuery({queryKey:['email-settings',membershipId],queryFn:()=>apiGet<Panel>('/v1/desk/settings/email'),refetchInterval:15000,enabled:!!membershipId});
 async function action(command:string,input:unknown){setBusy(true);try{await runCommand(command,input,membershipId!);toast.success(t('email.saved'));await queryClient.invalidateQueries({queryKey:['email-settings',membershipId]});}catch(e){toast.danger(errorMessage(e));}finally{setBusy(false);}}
 const btn='min-h-14 rounded-lg border px-4 py-2 text-sm disabled:opacity-50';
 if(q.isLoading)return <p>{t('loading')}</p>;
 if(q.error)return <p role="alert">{errorMessage(q.error)}</p>;
 const d=q.data;if(!d)return null;
 const sender=(requestId:string|null,useCustom:boolean)=>({requestId,useCustom,fromLocal:d.settings?.from_local??'booking',replyTo:replyTo.trim()||d.settings?.reply_to||null});
 return <section className="space-y-5 rounded-xl border bg-white p-5">
  <h3 className="font-semibold">{t('email.title')}</h3><p>{t('email.intro')}</p>
  <p>{d.defaultSender}</p><p>{t('email.account')}: {d.account?`${d.account.account_email} · ${d.account.status}`:t('email.empty')}</p>
  <div className="flex flex-wrap gap-2">
   <input aria-label={t('email.domain')} placeholder="mail.yoursalon.com" className="min-h-14 rounded border p-3" value={domain} onChange={e=>setDomain(e.target.value)}/>
   <select aria-label={t('email.platform')} className="rounded border p-3" value={managedBy} onChange={e=>setManagedBy(e.target.value)}>
    <option value="platform">{t('email.platform')}</option><option value="customer">{t('email.customer')}</option>
   </select>
   <button type="button" className={btn} disabled={busy||!domain.trim()} onClick={()=>void action('email.requestDomain',{domain,managedBy})}>{t('email.request')}</button>
  </div>
  <details><summary className="cursor-pointer font-medium">{t('email.tutorial')}</summary><p className="mt-3">{t('email.dnsHelp')}</p></details>
  {d.domains.map(r=><article key={r.id} className="space-y-3 rounded border p-4">
   <p className="font-medium">{r.domain} · {r.status}{d.settings?.use_custom&&d.settings.domain_request_id===r.id?' ✓':''}</p>
   {r.note&&<p>{r.note}</p>}{r.last_error&&<p role="alert">{r.last_error}</p>}
   <div className="overflow-x-auto"><table className="w-full text-sm"><tbody>{r.dns_records.map(record=><tr key={record.name} className="border-b">
    <td className="p-2">{record.type}</td><td className="p-2"><code>{record.name}</code></td><td className="max-w-md break-all p-2"><code>{record.value}</code></td><td>{record.action}</td>
    <td><button type="button" className={btn} onClick={()=>void navigator.clipboard.writeText(record.value)}>{t('copy')}</button></td>
   </tr>)}</tbody></table></div>
   <div className="flex gap-2"><button type="button" className={btn} disabled={busy} onClick={()=>void action('email.recheckDomain',{requestId:r.id})}>{t('email.check')}</button>
   <button type="button" className={btn} disabled={busy||r.status!=='verified'} onClick={()=>void action('email.setSender',sender(r.id,true))}>{t('email.use')}</button></div>
  </article>)}
  <button type="button" className={btn} disabled={busy} onClick={()=>void action('email.setSender',sender(null,false))}>{t('email.default')}</button>
  <div className="flex flex-wrap gap-2"><input type="email" aria-label={t('email.replyTo')} placeholder={d.settings?.reply_to??t('email.replyTo')} className="min-h-14 rounded border p-3" value={replyTo} onChange={e=>setReplyTo(e.target.value)}/>
  <button type="button" className={btn} disabled={busy} onClick={()=>void action('email.setSender',{...sender(d.settings?.domain_request_id??null,d.settings?.use_custom??false),replyTo:replyTo.trim()||null})}>{t('email.save')}</button></div>
  <h4 className="font-medium">{t('email.validation')}</h4><p className="text-sm">{t('email.validationHelp')}</p>
  <textarea className="w-full rounded border p-3" value={emails} onChange={e=>setEmails(e.target.value)} aria-label={t('email.validation')}/>
  <button type="button" className={btn} disabled={busy||!emails.trim()} onClick={()=>void action('email.validateCustomers',{emails:emails.split(/[\s,;]+/).filter(Boolean)})}>{t('email.validate')}</button>
  {d.validation.map(v=><p key={v.email} className="text-sm">{v.email} · {v.result} · {v.reason}</p>)}
  <h4 className="font-medium">{t('email.messages')}</h4>
  {!d.messages.length&&<p>{t('email.empty')}</p>}
  <div className="max-h-96 space-y-2 overflow-auto">{d.messages.map(m=><p key={m.id} className="border-b py-2 text-sm">{m.to_email} · {m.subject}<br/>{m.status} · {m.delivery_state??m.last_error??''}</p>)}</div>
 </section>;
}
