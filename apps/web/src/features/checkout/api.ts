/**
 * 结账数据层。
 *
 * 读：`GET /v1/desk/tickets` 未结工单列表。
 * 写：`ticket.close` 结账、`ticket.void` 作废。
 */
import {useEffect,useState} from 'react';
import {TicketPay,TicketCloseGroup} from '@gf/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand,ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {MembershipDiscountSelection,TicketQuoteCheckout,TicketQuoteGroup} from '@gf/contracts';
import type { CloseResult, OpenTicketsView, PaymentLine, PaymentStage } from './types';

export const checkoutKeys = {
  openTickets: (membershipId: string | null) => ['desk', 'tickets', membershipId] as const,
};

export type CheckoutQuoteInput=typeof TicketQuoteCheckout.input._input;
export type CheckoutQuote=typeof TicketQuoteCheckout.output._type;
export function useCheckoutQuote(input:CheckoutQuoteInput|null){
  const {membershipId,status,isOnline}=useSession();
  return useQuery({queryKey:['checkout','quote',membershipId,input],
    queryFn:async()=> (await runCommand<CheckoutQuote>('ticket.quoteCheckout',input!,membershipId!)).result,
    enabled:status==='ready'&&!!membershipId&&isOnline!==false&&!!input,retry:false,staleTime:0,refetchOnWindowFocus:true});
}

export function useOpenTickets() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: checkoutKeys.openTickets(membershipId),
    queryFn: () => apiGet<OpenTicketsView>('/v1/desk/tickets'),
    enabled: status === 'ready' && membershipId !== null,
    /* 工单会被技师端与门口 Kiosk 同时改动，窗口重新聚焦时重新拉取。 */
    refetchOnWindowFocus: true,
  });
}

export interface CloseTicketInput {
  ticketId: string;
  payments: PaymentLine[];
  discountCents: number;
  taxCents?: number;
  taxRateBp?: number;
  taxCalculationMode?: 'exclusive' | 'inclusive';
  surchargeCents?: number;
  surchargeRateBp?: number;
  tipTotalCents?: number;
  tipSplits?: Array<{
    staffMembershipId: string;
    staffName?: string;
    amountCents: number;
    percentageBp?: number;
  }>;
  packageRedemptions?: Array<{ customerPackageId: string; units: number }>;
  membershipRedemptions?:Array<{cycleId:string;ticketItemIds:string[]}>;
  membershipDiscount?:MembershipDiscountSelection;
  depositApplication?:{holdId:string;amountCents:number};
  notes?: string;
  idempotencyKey?: string;
  paymentStage?: PaymentStage;
  expectedQuoteHash?: string;
}

export type CloseGroupInput=typeof TicketCloseGroup.input._input&{idempotencyKey?:string};
export type CloseGroupResult=typeof TicketCloseGroup.output._type;
export type GroupQuoteInput=typeof TicketQuoteGroup.input._input;
export type GroupQuote=typeof TicketQuoteGroup.output._type;
export function useGroupQuote(input:GroupQuoteInput|null){
 const {membershipId,status,isOnline}=useSession();
 return useQuery({queryKey:['checkout','group-quote',membershipId,input],enabled:status==='ready'&&!!membershipId&&isOnline!==false&&!!input,retry:false,staleTime:0,
  queryFn:async()=>(await runCommand<GroupQuote>('ticket.quoteGroup',input!,membershipId!)).result});
}
type Command='ticket.pay'|'ticket.closeGroup';
type Inputs={'ticket.pay':CloseTicketInput;'ticket.closeGroup':CloseGroupInput};
type Results={'ticket.pay':CloseResult;'ticket.closeGroup':CloseGroupResult};
type Pending={command:'ticket.pay';key:string;input:CloseTicketInput}|{command:'ticket.closeGroup';key:string;input:CloseGroupInput};
function paymentPayload(command:Command,input:unknown){return command==='ticket.pay'?TicketPay.input.parse(input):TicketCloseGroup.input.parse(input);}
function useCheckoutCommand<C extends Command>(command:C){
 const queryClient=useQueryClient(),{membershipId}=useSession(),storageKey=`gf-ticket-payment:${membershipId}`;
 const readPending=():Pending|null=>{try{const raw=JSON.parse(sessionStorage.getItem(storageKey)??'null');
  if(!raw||typeof raw.key!=='string')return null;const command=raw.command??'ticket.pay';if(command!=='ticket.pay'&&command!=='ticket.closeGroup')return null;
  paymentPayload(command,raw.input);return {...raw,command} as Pending;
 }catch{return null;}};
 const [stored,setStored]=useState(()=>({storageKey,value:readPending()}));const pending=stored.storageKey===storageKey?stored.value:null;
 useEffect(()=>{const sync=()=>setStored({storageKey,value:readPending()});sync();window.addEventListener('gf-ticket-payment-changed',sync);return()=>window.removeEventListener('gf-ticket-payment-changed',sync);},[storageKey]);
 function preserve(value:Pending|null){if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);setStored({storageKey,value});window.dispatchEvent(new Event('gf-ticket-payment-changed'));}
 const mutation=useMutation({mutationFn:async(input:Inputs[C]):Promise<Results[C]>=>{
  const payload=paymentPayload(command,input),saved=readPending()??pending;
  if(saved&&(saved.command!==command||JSON.stringify(paymentPayload(saved.command,saved.input))!==JSON.stringify(payload)))throw new ApiError('VALIDATION_FAILED',{reason:'checkout_result_unknown'},false,409);
  const attempt=saved??({command,key:input.idempotencyKey??crypto.randomUUID(),input} as Pending);preserve(attempt);
  try{const response=await runCommand<Results[C]>(command,payload,membershipId!,attempt.key);
   if(command==='ticket.pay'&&(response.result as CloseResult).ticketId!==(input as CloseTicketInput).ticketId)throw new Error('CHECKOUT_RESPONSE_MISMATCH');
   if(command==='ticket.closeGroup'){const result=response.result as CloseGroupResult,request=input as CloseGroupInput;
    if(result.groupId!==request.groupId||JSON.stringify(result.tickets.map(t=>t.ticketId).sort())!==JSON.stringify([...request.ticketIds].sort()))throw new Error('CHECKOUT_RESPONSE_MISMATCH');}
   preserve(null);return response.result;
  }catch(e){if(e instanceof ApiError&&e.status>0&&e.status<500&&(!saved||(![401,403,429].includes(e.status)&&e.code!=='IDEMPOTENCY_KEY_REUSED')))preserve(null);throw e;}
 },onSuccess:()=>{for(const queryKey of [['desk','tickets'],['desk','orders'],['desk','dayclose'],['desk','day']])void queryClient.invalidateQueries({queryKey});}});
 return {...mutation,pendingPayment:pending?.command==='ticket.pay'?pending.input:null,pendingGroupPayment:pending?.command==='ticket.closeGroup'?pending.input:null,hasPendingSettlement:!!pending};
}
export function useCloseTicket(){return useCheckoutCommand('ticket.pay');}
export function useCloseGroup(){return useCheckoutCommand('ticket.closeGroup');}

export interface VoidTicketInput {
  ticketId: string;
  reason: string;
  note?: string;
}

export function useVoidTicket() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: VoidTicketInput) =>
      (await runCommand<{ ticketId: string }>(
        'ticket.void',
        {
          ticketId: input.ticketId,
          reason: input.reason,
          ...(input.note ? { note: input.note } : {}),
        },
        membershipId!,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: checkoutKeys.openTickets(membershipId) });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'orders'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'dayclose'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export async function verifyGiftCard(code: string): Promise<import('./types').GiftCardVerifyResult> {
  return apiGet<import('./types').GiftCardVerifyResult>(
    `/v1/desk/gift-cards/verify?code=${encodeURIComponent(code.trim())}`,
  );
}


/**
 * 金额解析：把用户输入的美元字符串转为整数分。
 *
 * ⚠️ 不使用 `Number(x) * 100`：浮点乘法在 `1.005` 这类输入上得到
 * 100.49999999999999，四舍五入后少一分。全程按字符串解析、整数运算。
 * 多余小数位一律截断而非进位 —— 宁可少收，不可多收。
 */
export function dollarsToCents(input: string): number {
  const cleaned = input.trim().replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  const negative = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const cents = (Number(whole) || 0) * 100 + Number(`${frac}00`.slice(0, 2));
  return negative ? -cents : cents;
}

/** 整数分 → 展示用金额字符串，始终两位小数。 */
export function centsToDollars(cents: number | null | undefined): string {
  const n = typeof cents === 'number' && Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const negative = n < 0;
  const abs = Math.abs(n);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 整数分 → 展示用美元数值。
 *
 * 仅供图表坐标、比例计算这类**必须是数字**的呈现场景使用。
 *
 * ⚠️ 不要先用 `centsToDollars` 格式化成字符串再解析回浮点：那既多一次有损
 * 转换，也让「金额只用整数分」的静态检查无法把它与真正的浮点解析区分开。
 * **任何金额的加减乘除仍必须在分上进行**，本函数只用于最后一步呈现。
 */
export function toDisplayDollars(cents: number): number {
  return cents / 100;
}
