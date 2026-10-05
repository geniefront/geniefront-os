import {createHash} from 'node:crypto';
import {AppError,ERROR_CODES,CommerceHoldAppointment,AppointmentCreate,VoiceBookingInput} from '@gf/contracts';
import {commerceFingerprint} from '@gf/payroll';
import type {HandlerArgs} from '../bus';
import {executeSingleAppointmentInTx} from './appointment';
import {holdAppointmentInTransaction,startDepositCheckoutInTransaction} from './appointmentDeposits';
import {queuePendingDepositNotice} from './appointmentDepositNotices';
import {voiceDepositQuote,voiceOnlineDepositReady,currentVoiceBooking} from '../voice/deposit';

/** Voice uses the same capacity, immutable quote, payment and outbox transaction as public booking. */
export async function createVoiceAppointmentInTransaction(args:HandlerArgs<typeof VoiceBookingInput._type>,
  payload:typeof AppointmentCreate.input._type,serviceTotalCents:number){
  const {tx,ctx,input}=args;
  const quote=await voiceDepositQuote(tx,ctx.locationId,serviceTotalCents);
  if(!quote){
    if(input.depositConsent)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_quote_changed',deposit:null,
      guidance:'The store no longer requires this quoted deposit. Refresh availability and confirm the current booking terms.'}});
    const out=await executeSingleAppointmentInTx(tx,ctx,payload);return currentVoiceBooking(tx,ctx,out.appointmentId);
  }
  const consent=input.depositConsent;
  if(!consent)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_confirmation_required',deposit:quote,
    guidance:'State the deposit amount, payment deadline and cancellation policy. Obtain explicit agreement and submit depositConsent with the returned policyVersion, serviceTotalCents and amountCents. Do not claim the appointment is confirmed.'}});
  if(consent.policyVersion!==quote.policyVersion||consent.amountCents!==quote.amountCents||consent.serviceTotalCents!==quote.serviceTotalCents)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_quote_changed',deposit:quote,
      guidance:'Refresh availability and the deposit quote, then obtain agreement to the updated terms before submitting again.'}});
  const {depositConsent:_,...intent}=input;
  const businessKey='voice:'+createHash('sha256').update(commerceFingerprint([ctx.locationId,intent])).digest('hex');
  const hold=await holdAppointmentInTransaction({...args,input:CommerceHoldAppointment.input.parse({appointment:payload,businessKey,depositConsent:consent})},
    input.items?undefined:{nativeVoiceGuestIndices:payload.items.map((_,index)=>[index])});
  // A caller without email needs frontdesk help; keep the payment channel open for an actual cash/card record.
  if(input.email&&await voiceOnlineDepositReady(tx,ctx)){
    try{await startDepositCheckoutInTransaction({...args,input:{holdId:hold.holdId}});}
    catch(e){if(!(e instanceof AppError&&e.details?.reason==='merchant_payments_unavailable'))throw e;}
  }
  await queuePendingDepositNotice(tx,ctx,hold.holdId);
  return currentVoiceBooking(tx,ctx,hold.appointmentId);
}
