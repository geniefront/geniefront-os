import {useEffect,useRef,useState} from 'react';
import {runCommand} from '@/lib/api';
import {useSession} from '@/lib/session';
type Request<T>={input:T;key:string;actor:string;meta?:Record<string,unknown>};
/** An uncertain financial action keeps its original parameters and key across a page reload. */
export function useDurableDepositCommand<T>(command:string,scope:string,schema:{safeParse:(value:unknown)=>{success:boolean;data?:T}}){
 const {membershipId}=useSession(),storage=`gf-deposit-command:${membershipId}:${command}:${scope}`;
 const read=():Request<T>|null=>{try{const raw=JSON.parse(sessionStorage.getItem(storage)??'null'),parsed=schema.safeParse(raw?.input);
  return parsed.success&&raw.actor===membershipId&&typeof raw.key==='string'&&/^[0-9a-f-]{36}$/i.test(raw.key)?{...raw,input:parsed.data}:null;}catch{return null;}};
 const [saved,setSaved]=useState<{storage:string;request:Request<T>|null}>(()=>({storage,request:read()}));
 const [busy,setBusy]=useState(false),running=useRef(false);
 useEffect(()=>{setSaved({storage,request:read()});},[storage]);
 const pending=saved.storage===storage?saved.request:null;
 async function execute<R=unknown>(input:T,meta?:Record<string,unknown>):Promise<R>{
  if(running.current||!membershipId)throw new Error('deposit_action_unavailable');
  const request=pending??{input,key:crypto.randomUUID(),actor:membershipId,...(meta?{meta}:{})};
  running.current=true;setBusy(true);
  try{
   sessionStorage.setItem(storage,JSON.stringify(request));setSaved({storage,request});
   const response=await runCommand<R>(command,request.input,membershipId,request.key);
   sessionStorage.removeItem(storage);setSaved({storage,request:null});return response.result;
  }catch(error){
   const {status,details}=(error as {status?:number;details?:{reason?:string;notApplied?:boolean}});
   // These answers are produced after the bus locks this key and proves there is no committed receipt.
   const confirmedNotApplied=details?.notApplied===true&&['deposit_quote_reconfirmation_required','deposit_excess_quote_changed'].includes(details.reason??'');
   // A refusal to retry does not prove an earlier unknown request failed.
   if(confirmedNotApplied||!pending&&status&&status>=400&&status<500){sessionStorage.removeItem(storage);setSaved({storage,request:null});}
   throw error;
  }finally{running.current=false;setBusy(false);}
 }
 return {pending,busy,execute};
}
