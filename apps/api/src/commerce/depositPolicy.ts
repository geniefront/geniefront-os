import {createHash} from 'node:crypto';
import type {OnlineBookingConfig} from '@gf/db';
import {commerceFingerprint} from '@gf/payroll';

/** Stable public policy identity; no clock, customer data, or secrets are included. */
export function appointmentDepositPolicy(booking:OnlineBookingConfig){
  const method=booking.depositMethod??'fixed';
  const terms={method,fixedAmountCents:method==='fixed'?(booking.depositAmountCents??2000):null,
    percentBps:method==='percentage'?(booking.depositPercentBps??null):null,holdMinutes:15,
    cancelCutoffHours:booking.cancelCutoffHours,cancellationPolicyNotice:booking.cancellationPolicyNotice??'',
    retainAfterCutoff:booking.retainDepositAfterCutoff===true};
  return {...terms,version:`appointment-deposit-v2:${createHash('sha256').update(commerceFingerprint(terms)).digest('hex')}`};
}
