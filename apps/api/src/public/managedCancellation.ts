import {createHash} from 'node:crypto';
import type postgres from 'postgres';
import {AppError,ERROR_CODES,type CommandContext} from '@gf/contracts';
import {readOnlineBooking} from '@gf/db';
import {sameDigest} from './bookingToken';
import {depositCancellationCutoff,guestCancelBlockReason} from './managedDetail';

export const managedPhoneDigest=(phone:string|null)=>phone===null?null:createHash('sha256').update(phone).digest('hex');

/** The public route verifies last4; this rechecks the same token and phone under locks. */
export async function assertManagedGuestCancellation(tx:postgres.TransactionSql,ctx:CommandContext,appointmentId:string){
  const proof=ctx.verifiedManagedBooking;
  const missing=()=>new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'booking'}});
  if(ctx.actorKind!=='api'||ctx.userId||ctx.membershipId||!proof||proof.appointmentId!==appointmentId)throw missing();
  const [a]=await tx<{status:string;starts_at:string;created_at:string;manage_token_digest:string|null;customer_id:string|null;
    settings:Record<string,unknown>;policy:Record<string,unknown>|null}[]>`
    select a.status,a.starts_at::text,a.created_at::text,a.manage_token_digest,a.customer_id,l.settings,h.policy_snapshot as policy
    from appointments a join locations l on l.id=a.location_id left join commerce_appointment_holds h on h.appointment_id=a.id
    where a.id=${appointmentId} and a.location_id=${ctx.locationId} and a.source in('web','phone_ai','phone_manual','desk')`;
  if(!a?.manage_token_digest||!sameDigest(a.manage_token_digest,proof.manageTokenDigest))throw missing();
  const [customer]=a.customer_id?await tx<{phone_e164:string|null}[]>`select phone_e164 from customers where id=${a.customer_id} for share`:[];
  const phoneDigest=managedPhoneDigest(customer?.phone_e164??null);
  if(phoneDigest!==proof.verifiedPhoneDigest)throw missing();
  const cfg=readOnlineBooking(a.settings);
  const reason=guestCancelBlockReason({status:a.status,startsAt:a.starts_at,createdAt:a.created_at,
    cancelCutoffHours:depositCancellationCutoff(a.policy,cfg.cancelCutoffHours),rescheduleEnabled:cfg.rescheduleEnabled,
    rescheduleCutoffHours:cfg.rescheduleCutoffHours,selfRescheduleMax:cfg.selfRescheduleMax,selfRescheduleCount:0});
  if(reason)throw new AppError(ERROR_CODES.PERMISSION_DENIED,{details:{reason}});
}
