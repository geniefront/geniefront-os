import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {commerceText,type CommerceTextKey} from '@gf/contracts';
import {apiGet,runCommand} from '@/lib/api';
import {useSession} from '@/lib/session';
import {useAttemptKey} from '@/lib/idempotency';
import {useGiftCardsQuery,usePackagesQuery} from '@/features/marketing/api';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Card,CardContent} from '@/components/ui/Card';

interface AssetDetail {
  asset:{id:string;name:string;currency:string;status:string;credential_disabled?:boolean;credential_version?:number;commerce_frozen:boolean;
    balance_cents?:number;remaining_sessions?:number;total_sessions?:number;reserved_cents?:number;reserved_sessions?:number;refund_frozen?:boolean;expires_at:string|null;code?:string|null;qr?:string|null};
  ledger:Array<{id:string;entry:string;value_cents:number;quantity?:number;created_at:string;unit_ranges?:string|null;restored?:boolean;settled_service?:boolean}>;
  nextOffset:number|null;
}
const entryKeys:Record<string,CommerceTextKey>={issue:'purchaseDetails',redeem:'sessionsUsed',restore:'restored',refund:'refunded',adjust:'adjusted',expire:'expired',opening:'historicalBalance'};
export function CommerceAssets({language}:{language:string}){
  const {membershipId,can,isOnline,context}=useSession(),cache=useQueryClient(),attempt=useAttemptKey();
  const gifts=useGiftCardsQuery(),packages=usePackagesQuery();
  const [selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [offset,setOffset]=useState(0);
  const [kind,id]=selected.split(':');
  const detail=useQuery({queryKey:['desk','commerce-asset',membershipId,selected,offset],enabled:!!membershipId&&!!selected,refetchInterval:10_000,
    queryFn:()=>apiGet<AssetDetail>(`/v1/desk/commerce/assets/${kind}/${id}?offset=${offset}`)});
  const text=(key:CommerceTextKey)=>commerceText(language,key);
  const money=(n:number,currency:string)=>new Intl.NumberFormat(language,{style:'currency',currency}).format(n/100);
  const date=(value:string)=>new Intl.DateTimeFormat(language,{dateStyle:'medium',timeStyle:'short',timeZone:context?.timezone??'UTC'}).format(new Date(value));
  async function mutate(command:string,input:unknown){
    setBusy(true);setMessage('');const intent=[command,input,membershipId];
    try{await runCommand(command,input,membershipId!,attempt.take(intent));attempt.settle(intent);setMessage(text('success'));
      await Promise.all([detail.refetch(),cache.invalidateQueries({queryKey:['desk','packages']}),cache.invalidateQueries({queryKey:['desk','giftcards']}),cache.invalidateQueries({queryKey:['desk','commerce']}),cache.invalidateQueries({queryKey:['desk','commerce-receipt']})]);
    }catch{setMessage(text('error'));}finally{setBusy(false);}
  }
  const asset=detail.data?.asset,writable=isOnline&&!busy&&can('commerce.refund');
  const frozen=!!asset&&(asset.commerce_frozen||asset.refund_frozen||['void','expired'].includes(asset.status)||!!asset.expires_at&&new Date(asset.expires_at)<new Date());
  return <Card><CardContent className="space-y-4 p-5"><h2 className="text-lg font-semibold">{text('ledger')}</h2>
    <label className="block text-sm">{text('product')}<select value={selected} onChange={e=>{setSelected(e.target.value);setOffset(0);setMessage('');}} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3">
      <option value="">{text('product')}</option>
      {(gifts.data?.giftCards??gifts.data?.rows??[]).map(g=><option key={g.id} value={`gift_card:${g.id}`}>{text('gifts')} · {g.purchaserName??g.recipientName??''} · {g.code.slice(-4)}</option>)}
      {packages.data?.userPackages.map(p=><option key={p.id} value={`package:${p.id}`}>{p.customerName} · {p.templateName}</option>)}
    </select></label>
    {message?<p role="status" className="text-sm">{message}</p>:null}
    {detail.isFetching&&selected?<p>{text('processing')}</p>:null}{detail.error?<p role="alert">{text('error')}</p>:null}
    {asset?<><p className="text-sm">{asset.name} · {asset.commerce_frozen?text('review'):asset.credential_disabled?text('disabled'):asset.refund_frozen?text('processing'):text('balance')}
      {' · '}{kind==='gift_card'?money(frozen||asset.credential_disabled?0:Math.max(0,(asset.balance_cents??0)-(asset.reserved_cents??0)),asset.currency):frozen?0:asset.total_sessions===0?text('unlimited'):Math.max(0,(asset.remaining_sessions??0)-(asset.reserved_sessions??0))}</p>
      {asset.code?<div className="flex flex-wrap items-center gap-3">{asset.qr?<img src={asset.qr} alt={text('gifts')} width={140} height={140}/>:null}<p className="break-all font-mono">{asset.code}</p></div>:null}
      {kind==='gift_card'&&can('commerce.refund')?<form className="flex flex-wrap items-end gap-3" onSubmit={e=>{
        e.preventDefault();const values=new FormData(e.currentTarget),submitter=(e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null;
        void mutate(submitter?.value==='reissue'?'giftcard.reissue':'giftcard.disable',{giftCardId:asset.id,expectedVersion:asset.credential_version,reason:String(values.get('reason'))});
      }}><label className="text-sm">{text('reason')}<Input name="reason" minLength={2} required/></label>
        <Button type="submit" value="disable" disabled={!writable||asset.credential_disabled}>{text('disableCard')}</Button>
        <Button type="submit" value="reissue" disabled={!writable||frozen}>{text('reissueCard')}</Button>
      </form>:null}
      <div className="space-y-3">{detail.data?.ledger.map(row=><article key={row.id} className="border-b border-slate-100 pb-3 text-sm">
        <p>{text(entryKeys[row.entry]??'ledger')} · {row.quantity!==undefined?`${row.quantity} ${text('sessions')}`:''}
          {kind==='gift_card'?`${text('faceValue')}: ${money(row.value_cents,asset.currency)}`:row.unit_ranges===null?'':` · ${text('purchasePrice')}: ${money(row.value_cents,asset.currency)}`}</p>
        <time className="text-xs text-slate-500">{date(row.created_at)}</time>
        {kind==='package'&&row.entry==='redeem'&&!row.restored?<>
          {row.unit_ranges===null?<p className="text-xs text-amber-700">{text('historicalUnits')}</p>:row.settled_service?<p className="text-xs text-slate-500">{text('settledService')}</p>:
            can('commerce.refund')&&!frozen?<form className="mt-2 flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();const values=new FormData(e.currentTarget);
              void mutate('package.restore',{redemptionId:row.id,reason:String(values.get('reason'))});
            }}><label>{text('reason')}<Input name="reason" minLength={2} required/></label><Button type="submit" disabled={!writable}>{text('restore')}</Button></form>:null}
        </>:null}
      </article>)}</div><div className="flex gap-2">
        {offset>0?<Button variant="outline" onPress={()=>setOffset(Math.max(0,offset-200))}>{text('previous')}</Button>:null}
        {detail.data?.nextOffset!==null&&detail.data?.nextOffset!==undefined?<Button variant="outline" onPress={()=>setOffset(detail.data!.nextOffset!)}>{text('next')}</Button>:null}
      </div>
    </>:null}
  </CardContent></Card>;
}
