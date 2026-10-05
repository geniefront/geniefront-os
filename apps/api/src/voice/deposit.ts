import {AppError,ERROR_CODES,VoiceDepositQuote,SubmitVoiceBooking,type CommandContext} from '@gf/contracts';
import {readOnlineBooking} from '@gf/db';
import {quoteAppointmentDeposit} from '@gf/payroll';
import type {Tx} from '../commerce/model';
import {commerceEnabled,commerceLiveMode} from '../commerce/config';
import {appointmentDepositPolicy} from '../commerce/depositPolicy';
import {depositRequestDetails} from '../commerce/depositRequestDetails';

export function voiceDepositQuoteFromSettings(settings:Record<string,unknown>,currency:string,serviceTotalCents:number){
  const booking=readOnlineBooking(settings);
  if(!commerceEnabled()||!(settings.commerce as {depositsEnabled?:boolean}|undefined)?.depositsEnabled||!booking.depositRequired)return null;
  const policy=appointmentDepositPolicy(booking);
  const amount=quoteAppointmentDeposit(serviceTotalCents,policy.method==='percentage'?{percentBps:policy.percentBps!}:{fixedAmountCents:policy.fixedAmountCents!});
  if(amount<=0)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_requires_positive_service_total'}});
  return VoiceDepositQuote.parse({required:true,policyVersion:policy.version,amountCents:amount,serviceTotalCents,currency:currency.toUpperCase(),
    cancelCutoffHours:policy.cancelCutoffHours,retainAfterCutoff:policy.retainAfterCutoff,policyNotice:policy.cancellationPolicyNotice??'',holdMinutes:15});
}
export async function voiceDepositQuote(tx:Tx,locationId:string,serviceTotalCents:number){
  const [loc]=await tx<{settings:Record<string,unknown>;currency:string}[]>`select settings,currency from locations where id=${locationId}`;
  if(!loc)throw new AppError(ERROR_CODES.NOT_FOUND);
  return voiceDepositQuoteFromSettings(loc.settings,loc.currency,serviceTotalCents);
}

export async function voiceOnlineDepositReady(tx:Tx,ctx:CommandContext):Promise<boolean>{
  if(process.env.BOOKING_MANAGE_PAGE_ENABLED!=='1'||!process.env.BOOKING_BASE_URL)return false;
  let mode:boolean;
  try{mode=commerceLiveMode();}catch(e){if(e instanceof AppError&&e.details?.reason==='mode_key_mismatch')return false;throw e;}
  const [account]=await tx`select id from commerce_accounts where location_id=${ctx.locationId} and livemode=${mode}
    and charges_enabled and not disconnected and capabilities->>'card_payments'='active'`;
  return !!account;
}

/** Read authoritative status after command replay; a cached pending result is not a fresh payment fact. */
export async function currentVoiceBooking(tx:Tx,ctx:CommandContext,appointmentId:string){
  const [a]=await tx<{id:string;status:string;deposit_status:string;business_date:string;hold_id:string|null;hold_status:string|null;amount_cents:number|null;
    has_confirmed_booking:boolean|null;current_required:number|null;settled:boolean;currency:string|null;expires_at:string|null;waived_at:string|null;commerce_frozen:boolean|null;order_id:string|null;expired:boolean;email_status:string|null}[]>`
    select a.id,a.status,a.deposit_status,a.business_date::text,h.id as hold_id,h.status as hold_status,h.amount_cents,h.currency,h.expires_at::text,
      h.waived_at,h.commerce_frozen,h.order_id,h.has_confirmed_booking,
      coalesce((select required_cents from commerce_deposit_requotes where hold_id=h.id order by revision desc limit 1),h.amount_cents) as current_required,
      exists(select 1 from tickets t where t.appointment_id=a.id and t.status<>'voided' and t.service_settled_at is not null) as settled,coalesce(h.expires_at<=now(),false) as expired,
      (select status from email_outbox e where e.entity_id=a.id and e.kind='appointment_deposit_pending' order by created_at desc,id desc limit 1) as email_status
    from appointments a left join commerce_appointment_holds h on h.appointment_id=a.id
    where a.id=${appointmentId} and a.location_id=${ctx.locationId}`;
  if(!a)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'appointment'}});
  const status=['cancelled','no_show'].includes(a.status)?(a.hold_status==='expired'?'expired':'cancelled'):
    a.commerce_frozen?'review':!a.hold_id||a.waived_at||a.has_confirmed_booking||a.deposit_status==='paid'?'confirmed':
      a.hold_status==='pending'?(a.expired?'expired':'pending_deposit'):'review';
  const request=a.hold_id?await depositRequestDetails(tx,ctx,a.hold_id):null;
  const [latest]=request?await tx<{status:string}[]>`select status from email_outbox where entity_id=${a.id} and kind='appointment_deposit_pending'
    and (commerce_order_id=${request.orderId} or commerce_order_id is null and ${request.purpose==='initial'}) order by created_at desc,id desc limit 1`:[];
  const delivery=request?latest?.status:a.email_status;
  const emailDelivery=['sent','captured','failed'].includes(delivery??'')?delivery as 'sent'|'captured'|'failed':delivery?'queued':'unavailable';
  const additional=status==='confirmed'&&!a.settled&&request?.purpose==='supplement'&&['open','expired'].includes(request.state)?{
    amountCents:request.amountCents,expiresAt:request.expiresAt,state:request.state==='expired'||Date.parse(request.expiresAt)<=Date.now()?'expired' as const:'open' as const,
    paymentAction:!request.payable?'none' as const:request.channel==='online'&&emailDelivery!=='unavailable'&&emailDelivery!=='failed'?'email_link' as const:'frontdesk' as const}:null;
  return SubmitVoiceBooking.output.parse({appointmentId:a.id,businessDate:a.business_date,status,bookingConfirmed:status==='confirmed'&&a.status==='booked',
    ...(a.hold_id?{deposit:{holdId:a.hold_id,amountCents:status==='pending_deposit'?(request?.amountCents??a.amount_cents!):(a.current_required??a.amount_cents!),currency:a.currency!.toUpperCase(),expiresAt:request?.expiresAt??new Date(a.expires_at!).toISOString(),
      ...(additional?{additionalPayment:additional}:{}),
      paymentAction:status!=='pending_deposit'?'none':request?.channel==='online'&&emailDelivery!=='unavailable'&&emailDelivery!=='failed'?'email_link':'frontdesk',emailDelivery}}:{})});
}
