import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {platformGet,platformSend} from '../lib/api';
type Data={provider:string;providerError:string|null;trackingLocked?:boolean;domains:Array<{Domain:string;Spf:boolean;Dkim:boolean;DMARC:boolean}>;
 requests:Array<{id:string;location_id:string;domain:string;status:string;managed_by:string;note:string;last_error:string|null;dns_records:Array<{type:string;name:string;value:string;action:string}>}>;
 accounts:Array<{location_id:string;account_email:string;status:string;last_error:string|null}>};
export function Email(){
 const qc=useQueryClient(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const q=useQuery({queryKey:['platform-email'],queryFn:()=>platformGet<Data>('/v1/platform/email'),refetchInterval:30000});
 async function act(path:string,body:unknown){setBusy(true);setError('');try{await platformSend('POST',path,body);await qc.invalidateQueries({queryKey:['platform-email']});}catch{setError('Operation failed. Please retry.');}finally{setBusy(false);}}
 if(q.isLoading)return <p>Loading…</p>;if(q.error||!q.data)return <p role="alert">Unable to load email settings.</p>;
 const d=q.data;
 return <div className="space-y-6"><h1 className="text-2xl font-semibold">Email delivery and domain requests</h1>
 <p>Provider: {d.provider} · Marketing: coming soon{d.trackingLocked?' · Tracking: account default (links rewritten)':''}</p>{(error||d.providerError)&&<p role="alert">{error||d.providerError}</p>}
 <section className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Platform domains</h2>{d.domains.map(x=><p key={x.Domain}>{x.Domain} · SPF {String(x.Spf)} · DKIM {String(x.Dkim)} · DMARC {String(x.DMARC)}</p>)}</section>
 <section><h2 className="font-semibold">DNS work orders</h2><p>Add the records at the domain's DNS host. Merge SPF; preserve existing MX. Cloudflare tracking CNAME must be DNS only. The _geniefront record proves tenant ownership.</p>
 {!d.requests.length&&<p>No pending requests.</p>}
 {d.requests.map(r=><article className="my-3 space-y-3 rounded-xl border bg-white p-4" key={r.id}>
 <p><strong>{r.domain}</strong> · {r.status} · {r.managed_by} · <Link className="underline" to={`/stores/${r.location_id}`}>Open store</Link></p>
 {r.last_error&&<p>{r.last_error}</p>}
 <div className="overflow-auto"><table className="w-full text-sm"><tbody>{r.dns_records.map(x=><tr key={x.name} className="border-b"><td>{x.type}</td><td>{x.name}</td><td className="max-w-lg break-all p-2">{x.value}</td><td>{x.action}</td><td><button onClick={()=>void navigator.clipboard.writeText(x.value)}>Copy</button></td></tr>)}</tbody></table></div>
 <textarea className="w-full rounded border p-2" aria-label="Operator note" defaultValue={r.note} onBlur={e=>{if(e.target.value!==r.note)void act(`/v1/platform/email/requests/${r.id}`,{action:'note',note:e.target.value});}}/>
 <button className="rounded border p-3" disabled={busy} onClick={()=>void act(`/v1/platform/email/requests/${r.id}`,{action:'recheck',note:r.note})}>Recheck DNS</button>
 <button className="ml-3 rounded border p-3" disabled={busy||r.status==='cancelled'} onClick={()=>void act(`/v1/platform/email/requests/${r.id}`,{action:'cancel',note:r.note})}>Cancel request and restore platform sender</button>
 </article>)}</section>
 <section><h2 className="font-semibold">Subaccounts — marketing sending remains disabled</h2>{d.accounts.map(a=><div key={a.location_id} className="my-2 rounded border p-3"><Link to={`/stores/${a.location_id}`}>{a.account_email}</Link> · {a.status} · {a.last_error}
 <button className="ml-3 rounded border p-2" disabled={busy||a.status==='ready'} onClick={()=>void act(`/v1/platform/email/accounts/${a.location_id}`,{action:'retry'})}>Retry setup</button></div>)}</section>
 </div>;
}
