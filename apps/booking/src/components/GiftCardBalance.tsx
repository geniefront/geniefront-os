import {useEffect,useRef,useState} from 'react';
import {commerceText} from '@gf/contracts';
import {commerceApi} from '../lib/commerceApi';
import {Card,Btn} from './Chrome';
interface Balance {balanceCents:number;currency:string;status:string;expiresAt:string|null;timezone:string;qr:string|null;}
export function GiftCardBalance({slug,locale}:{slug:string;locale:string}){
  const [code,setCode]=useState(''),[balance,setBalance]=useState<Balance|null>(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const request=useRef(0);
  useEffect(()=>{request.current++;setBalance(null);setCode('');setFailed(false);setBusy(false);return()=>{request.current++;};},[slug]);
  const text=(key:Parameters<typeof commerceText>[1])=>commerceText(locale,key);
  async function lookup(){const current=++request.current;setBusy(true);setFailed(false);setBalance(null);
    try{const result=await commerceApi<Balance>(slug,'/gift-balance',{body:{code}});if(current===request.current)setBalance(result);}
    catch{if(current===request.current)setFailed(true);}finally{if(current===request.current)setBusy(false);}}
  return <Card className="mt-8 p-6"><details><summary className="cursor-pointer font-semibold">{text('giftLookup')}</summary>
    <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();void lookup();}}>
      <label className="grow text-sm">{text('cardCode')}<input className="booking-input mt-1 w-full font-mono" value={code} minLength={20} maxLength={60} required disabled={busy} autoComplete="off" spellCheck={false} onChange={e=>{setCode(e.target.value);setBalance(null);setFailed(false);}}/></label>
      <Btn type="submit" disabled={busy}>{text(busy?'processing':'lookup')}</Btn>
    </form>
    {failed?<p role="alert" className="mt-4 text-sm">{text('error')}</p>:null}
    {balance?<div role="status" className="mt-4 flex flex-wrap items-center gap-4">
      {balance.qr?<img src={balance.qr} width={140} height={140} alt={text('gifts')}/>:null}<div>
        <p>{text(balance.status==='disabled'?'disabled':balance.status==='review'?'review':balance.status==='expired'?'expired':'balance')}: {new Intl.NumberFormat(locale,{style:'currency',currency:balance.currency}).format(balance.balanceCents/100)}</p>
        <p className="mt-1 text-sm">{balance.expiresAt?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:balance.timezone??'UTC'}).format(new Date(balance.expiresAt)):text('noExpiry')}</p>
      </div></div>:null}
  </details></Card>;
}
