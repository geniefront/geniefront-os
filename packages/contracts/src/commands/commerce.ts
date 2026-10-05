import {depositAdjustmentConsent} from '../depositAdjustment.js';
import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';
import type { Permission } from '../permissions.js';
import { AppointmentCreate } from './appointment.js';

const money = z.number().int().min(0).max(1_000_000_000);
const metadata = { ai: { description: 'Customer commerce financial operation', confirm: 'always' as const, exposed: false },
  auditRedact:['faceValueCents','salePriceCents','balanceCents','priceCents','amountCents','refundedCents'],
  reversible: false, idempotency: 'required' as const };
const privateCommand = { ...metadata, system: true };
const orderResult = z.object({ orderId: uuid, status: z.string(), paymentId: uuid.nullable(), assetId: uuid.nullable() });
export const depositConsent=z.object({accepted:z.literal(true),policyVersion:z.string().min(1).max(160),
  serviceTotalCents:money,amountCents:money.positive()});
export const CommerceHoldAppointment=defineCommand({...metadata,name:'commerce.holdAppointment',input:z.object({
  appointment:AppointmentCreate.input,businessKey:z.string().min(8).max(160),
  depositConsent:depositConsent.optional(),
}),output:z.object({holdId:uuid,appointmentId:uuid,status:z.string(),amountCents:money.positive(),serviceTotalCents:money,
  currency:z.string(),expiresAt:z.string()}),permission:'appointment.write',fieldPermissions:[{
  field:'appointment.override',need:'appointment.overbook',used:v=>!!v.appointment?.override,
}]});
export const CommerceExpireAppointmentHold=defineCommand({...privateCommand,name:'commerce.expireAppointmentHold',input:z.object({
  holdId:uuid,
}),output:z.object({expired:z.boolean()})});
export const CommerceRecordOfflineDeposit=defineCommand({...metadata,name:'commerce.recordOfflineDeposit',input:z.object({
  holdId:uuid,orderId:uuid.optional(),amountCents:money.positive(),method:z.enum(['cash','card','external']),reference:z.string().trim().min(1).max(200),
}),output:orderResult,permission:'commerce.sell'});
export const CommerceStartDepositCheckout=defineCommand({...metadata,name:'commerce.startDepositCheckout',input:z.object({holdId:uuid}),
  output:orderResult,permission:'commerce.sell'});
export const CommerceSendDepositNotice=defineCommand({...metadata,name:'commerce.sendDepositNotice',input:z.object({holdId:uuid,
  reason:z.string().trim().min(2).max(500)}),output:z.object({queued:z.boolean()}),permission:'commerce.sell'});
export const CommerceWaiveAppointmentDeposit=defineCommand({...metadata,name:'commerce.waiveAppointmentDeposit',input:z.object({
  holdId:uuid,reason:z.string().trim().min(2).max(500),
}),output:z.object({holdId:uuid,appointmentId:uuid,status:z.literal('waived')}),permission:'commerce.waiveDeposit'});
export const CommercePublicDepositBooking=defineCommand({...privateCommand,name:'commerce.publicDepositBooking',input:CommerceHoldAppointment.input.extend({depositConsent}),
  output:CommerceHoldAppointment.output.extend({orderId:uuid,businessDate:z.string()})});
export const CommerceRequoteAppointmentDeposit=defineCommand({...metadata,name:'commerce.requoteAppointmentDeposit',input:z.object({
 holdId:uuid,depositAdjustment:depositAdjustmentConsent.optional(),channel:z.enum(['online','offline']).optional(),reason:z.string().trim().min(2).max(500),
}),output:z.object({quoteId:uuid,orderId:uuid.nullable(),revision:z.number().int().positive(),requestCents:money,excessCents:money}),permission:'commerce.sell'});
export const CommerceExpireDepositRequest=defineCommand({...privateCommand,name:'commerce.expireDepositRequest',input:z.object({orderId:uuid}),output:z.object({expired:z.boolean()})});
export const CommerceRefundExcessDeposit=defineCommand({...metadata,name:'commerce.refundExcessDeposit',input:z.object({
 holdId:uuid,quoteHash:z.string().regex(/^[a-f0-9]{64}$/),amountCents:money.positive(),reason:z.string().trim().min(2).max(500),
}),output:z.object({refunds:z.array(z.object({refundId:uuid,amountCents:money.positive(),status:z.string()}))}),permission:'commerce.refund'});
/** Compatibility issuance must still produce a real purchase or a reasoned gift. */
export const legacyCommerceSaleFields = {
  channel: z.enum(['offline','complimentary']),
  businessKey:z.string().min(8).max(160),
  offlinePayment:z.object({method:z.enum(['cash','card','external']),amountCents:money.positive(),reference:z.string().trim().min(1).max(200)}).optional(),
  reason:z.string().trim().min(2).max(500).optional(),
};
export const commercePurchaseInput = z.object({
  kind: z.enum(['gift_card','package']),
  templateId: uuid.optional(),
  customerId: uuid.optional(),
  customer: z.object({ name: z.string().trim().min(1).max(120), email: z.string().email().max(200),
    phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional() }).optional(),
  faceValueCents: money.positive().optional(), salePriceCents: money.optional(),
  scope:z.enum(['location','org']).optional(),
  packageOverrides:z.object({priceCents:money.optional(),sessions:z.number().int().min(0).optional(),validDays:z.number().int().positive().optional()}).optional(),
  recipientName: z.string().max(120).optional(), recipientNote: z.string().max(500).optional(),
  recipientEmail: z.string().email().max(200).optional(),
  channel: z.enum(['online','offline','complimentary']),
  offlinePayment: z.object({ method: z.enum(['cash','card','external']), amountCents: money.positive(),
    reference: z.string().trim().min(1).max(200) }).optional(),
  reason: z.string().trim().min(2).max(500).optional(),
  businessKey: z.string().min(8).max(160),
  expectedQuoteHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).superRefine((v, ctx) => {
  if (v.kind === 'package' && !v.templateId) ctx.addIssue({ code:'custom',path:['templateId'],message:'Package requires a template' });
  if (v.channel === 'offline' && !v.offlinePayment) ctx.addIssue({ code:'custom',path:['offlinePayment'],message:'Record the payment received' });
  if (v.channel === 'complimentary' && !v.reason) ctx.addIssue({ code:'custom',path:['reason'],message:'A reason is required' });
  if (v.channel !== 'offline' && v.offlinePayment) ctx.addIssue({ code:'custom',path:['offlinePayment'],message:'Wrong payment channel' });
  if (v.packageOverrides && !v.reason) ctx.addIssue({code:'custom',path:['reason'],message:'Explain the purchase override'});
});
export const CommerceCreateOrder = defineCommand({ ...metadata, name:'commerce.createOrder', input:commercePurchaseInput,
  output:orderResult, permission:'commerce.sell' as Permission,
  fieldPermissions:[{ field:'channel', used:(v) => v.channel === 'complimentary', need:'commerce.gift' as Permission },
    {field:'packageOverrides',used:v=>!!v.packageOverrides,need:'commerce.configure' as Permission},
    {field:'scope',used:v=>v.scope==='org',need:'commerce.configure' as Permission}] });
export const CommercePublicOrder = defineCommand({ ...privateCommand, name:'commerce.publicOrder',
  input:commercePurchaseInput, output:orderResult });
export const CommerceSaveAccount = defineCommand({ ...privateCommand, name:'commerce.saveAccount', input:z.object({
  stripeAccountId:z.string().regex(/^acct_[A-Za-z0-9]+$/), livemode:z.boolean(), chargesEnabled:z.boolean(),
  payoutsEnabled:z.boolean(), detailsSubmitted:z.boolean(), disconnected:z.boolean().default(false),
  apiVersion:z.enum(['v1','v2']).default('v1'),
  sourceEvent:z.object({id:z.string().min(1).max(200),type:z.string().min(1).max(200)}).optional(),
  capabilities:z.record(z.unknown()).default({}), requirements:z.record(z.unknown()).default({}),
}), output:z.object({ accountId:uuid }) });
export const CommerceSaveSettings = defineCommand({ ...metadata, name:'commerce.saveSettings',
  input:z.object({ salesEnabled:z.boolean(), depositsEnabled:z.boolean(), membershipsEnabled:z.boolean() }),
  output:z.object({ saved:z.boolean() }), permission:'commerce.configure' as Permission });
export const CommerceDisconnectAccount=defineCommand({...privateCommand,name:'commerce.disconnectAccount',input:z.object({
  stripeAccountId:z.string(),livemode:z.boolean(),eventId:z.string().min(1),
}),output:z.object({disconnected:z.boolean()})});
export const CommerceRecordPayment = defineCommand({ ...privateCommand, name:'commerce.recordPayment', input:z.object({
  orderId:uuid, stripeAccountId:z.string(), livemode:z.boolean(), eventId:z.string().min(1).max(200),
  eventType:z.string().min(1).max(100), sessionId:z.string().min(1), paymentIntentId:z.string().min(1),
  amountCents:money.positive(), currency:z.string().regex(/^[a-z]{3}$/),
}), output:orderResult });
export const CommerceRecordRisk=defineCommand({...privateCommand,name:'commerce.recordRisk',input:z.object({
  paymentIntentId:z.string().min(1),orderId:uuid.optional(),stripeAccountId:z.string().min(1),livemode:z.boolean(),
  kind:z.enum(['dispute','external_refund']),externalId:z.string().min(1).max(200),amountCents:money.positive(),currency:z.string().regex(/^[a-z]{3}$/),
  providerStatus:z.string().min(1).max(80),eventId:z.string().min(1).max(200),eventType:z.string().max(100),eventCreated:z.number().int().nonnegative(),
}),output:z.object({recorded:z.boolean(),frozen:z.boolean()})});
export const CommerceRecordSettlement=defineCommand({...privateCommand,name:'commerce.recordSettlement',input:z.object({
  target:z.enum(['payment','refund']),id:uuid,stripeAccountId:z.string().min(1),livemode:z.boolean(),providerId:z.string().min(1),
  originalAmountCents:money.positive(),balanceTransactionId:z.string().min(1),currency:z.string().regex(/^[a-z]{3}$/),
  grossCents:z.number().int().min(-1_000_000_000).max(1_000_000_000),feeCents:z.number().int().min(-1_000_000_000).max(1_000_000_000),
  netCents:z.number().int().min(-1_000_000_000).max(1_000_000_000),occurredAt:z.string().datetime(),availableOn:z.string().datetime(),
}),output:z.object({recorded:z.boolean()})});
export const CommerceExpireOrder=defineCommand({...privateCommand,name:'commerce.expireOrder',input:z.object({
  orderId:uuid,sessionId:z.string().min(1),stripeAccountId:z.string().min(1),livemode:z.boolean(),
}),output:z.object({expired:z.boolean()})});
export const CommerceRecordPayout=defineCommand({...privateCommand,name:'commerce.recordPayout',input:z.object({
 stripeAccountId:z.string().regex(/^acct_[A-Za-z0-9]+$/),livemode:z.boolean(),payoutId:z.string().regex(/^po_[A-Za-z0-9]+$/),
 amountCents:z.number().int().min(-1_000_000_000).max(1_000_000_000).refine(v=>v!==0),currency:z.string().regex(/^[a-z]{3}$/),automatic:z.boolean(),destinationType:z.enum(['bank_account','card']),
 createdAt:z.string().datetime(),arrivalAt:z.string().datetime(),observedAt:z.string().datetime(),status:z.enum(['pending','in_transit','paid','failed','canceled']),
 sourceCount:z.number().int().nonnegative().nullable().default(null),sourceNetCents:z.number().int().nullable().default(null),
 reconciliationStatus:z.enum(['not_applicable','in_progress','completed']),failureCode:z.string().max(100).nullable(),balanceTransactionId:z.string().nullable(),failureBalanceTransactionId:z.string().nullable(),
 event:z.object({id:z.string().min(1).max(200),type:z.string().min(1).max(100)}).optional(),
}),output:z.object({payoutId:uuid,recorded:z.boolean()})});
export const CommerceRecordPayoutTransaction=defineCommand({...privateCommand,name:'commerce.recordPayoutTransaction',input:z.object({
 payoutId:uuid,stripeAccountId:z.string().min(1),livemode:z.boolean(),role:z.enum(['debit','reversal','source']),balanceTransactionId:z.string().min(1),sourceId:z.string().nullable(),
 currency:z.string().regex(/^[a-z]{3}$/),grossCents:z.number().int(),feeCents:z.number().int(),netCents:z.number().int(),type:z.string().min(1).max(100),createdAt:z.string().datetime(),availableOn:z.string().datetime(),
}),output:z.object({recorded:z.boolean()})});
export const CommerceRefreshPayouts=defineCommand({...metadata,name:'commerce.refreshPayouts',input:z.object({}),output:z.object({queued:z.boolean()}),permission:'commerce.configure'});
export const CommerceSavePayoutScan=defineCommand({...privateCommand,name:'commerce.savePayoutScan',input:z.object({accountId:uuid,expectedCursor:z.string().nullable(),nextCursor:z.string().nullable()}),output:z.object({saved:z.boolean()})});
export const CommerceRenewTaskLease=defineCommand({...privateCommand,name:'commerce.renewTaskLease',input:z.object({taskId:uuid,leaseId:uuid}),output:z.object({renewed:z.boolean()})});
export const CommerceRequestRefund = defineCommand({ ...metadata, name:'commerce.requestRefund', input:z.object({
  paymentId:uuid, amountCents:money.positive(), reason:z.string().trim().min(2).max(500),
  unlimitedTerminationConfirmed:z.literal(true).optional(),
  depositGuestIndices:z.array(z.number().int().min(0).max(19)).min(1).max(20).optional(),
}), output:z.object({ refundId:uuid,status:z.string() }), permission:'commerce.refund' as Permission });
export const CommerceApproveGuestRefund=defineCommand({...metadata,name:'commerce.approveGuestRefund',input:z.object({
  refundId:uuid,reason:z.string().trim().min(2).max(500),
}),output:z.object({refundId:uuid,status:z.string()}),permission:'commerce.refund'});
export const CommerceRetainAppointmentDeposit=defineCommand({...metadata,name:'commerce.retainAppointmentDeposit',input:z.object({
  holdId:uuid,guestIndices:z.array(z.number().int().min(0).max(19)).min(1).max(20),
  expectedGuestBalances:z.array(z.object({guestIndex:z.number().int().min(0).max(19),availableCents:money})).min(1).max(20),
  amountCents:money.positive(),reason:z.string().trim().min(2).max(500),
}),output:z.object({retentionId:uuid,retentionIds:z.array(uuid).optional(),amountCents:money.positive(),status:z.string()}),permission:'commerce.retainDeposit'});
export const CommerceReleaseDepositRetention=defineCommand({...metadata,name:'commerce.releaseDepositRetention',input:z.object({
 retentionId:uuid,expectedRemainingCents:money.positive(),amountCents:money.positive(),reason:z.string().trim().min(2).max(500),
}),output:z.object({releaseId:uuid,refundId:uuid,status:z.string(),amountCents:money.positive()}),permission:'commerce.retainDeposit'});
export const CommerceApplyExternalRefund=defineCommand({...metadata,name:'commerce.applyExternalRefund',input:z.object({
  reviewId:uuid,reason:z.string().trim().min(2).max(500),
}),output:z.object({refundId:uuid,status:z.string()}),permission:'commerce.refund'});
export const CommerceCompleteRefund = defineCommand({ ...privateCommand, name:'commerce.completeRefund', input:z.object({
  refundId:uuid, stripeRefundId:z.string().nullable(), status:z.enum(['succeeded','failed','pending']),
  stripeAccountId:z.string().nullable(), livemode:z.boolean(), amountCents:money.positive(),
  event:z.object({id:z.string().min(1).max(200),type:z.enum(['refund.created','refund.updated','refund.failed'])}).optional(),
}), output:z.object({ refundId:uuid,status:z.string() }) });
export const CommerceConfirmOfflineRefund = defineCommand({ ...metadata, name:'commerce.confirmOfflineRefund', input:z.object({
  refundId:uuid,reference:z.string().trim().min(1).max(200),
}), output:z.object({refundId:uuid,status:z.string()}),permission:'commerce.refund' });
export const CommerceClaimTask = defineCommand({ ...privateCommand, name:'commerce.claimTask', input:z.object({
  taskId:uuid.optional(), leaseId:uuid,
}), output:z.object({ task:z.object({ id:uuid,kind:z.string(),subjectId:uuid,leaseId:uuid }).nullable() }) });
export const CommerceFinishTask = defineCommand({ ...privateCommand, name:'commerce.finishTask', input:z.object({
  taskId:uuid, leaseId:uuid, session:z.object({ id:z.string(),url:z.string().url().nullable(),expiresAt:z.string().datetime() }).optional(),
  error:z.string().max(120).optional(),
  nextRunAfterSec:z.number().int().min(5).max(86400).optional(),
}), output:z.object({ updated:z.boolean() }) });
export const CommerceRetryTask=defineCommand({...metadata,name:'commerce.retryTask',input:z.object({
  taskId:uuid,reason:z.string().trim().min(2).max(500),
}),output:z.object({queued:z.boolean()}),permission:'commerce.configure'});
export const CommerceResendNotice=defineCommand({...metadata,name:'commerce.resendNotice',input:z.object({
  orderId:uuid,reason:z.string().trim().min(2).max(500),
}),output:z.object({queued:z.boolean()}),permission:'commerce.sell'});
export const CommerceIssueAccess = defineCommand({ ...privateCommand, name:'commerce.issueAccess', input:z.object({
  orderId:uuid, tokenHash:z.string().regex(/^[a-f0-9]{64}$/),
}), output:z.object({ expiresAt:z.string() }) });
export const COMMERCE_COMMANDS = [CommerceRequoteAppointmentDeposit,CommerceExpireDepositRequest,CommerceRefundExcessDeposit,CommerceReleaseDepositRetention,CommerceRenewTaskLease,CommerceRefreshPayouts,CommerceSavePayoutScan,CommerceRecordPayout,CommerceRecordPayoutTransaction,CommerceRetainAppointmentDeposit,CommerceHoldAppointment,CommerceExpireAppointmentHold,CommerceRecordOfflineDeposit,CommerceStartDepositCheckout,CommerceSendDepositNotice,CommerceWaiveAppointmentDeposit,CommercePublicDepositBooking,CommerceCreateOrder,CommercePublicOrder,CommerceSaveAccount,CommerceSaveSettings,CommerceDisconnectAccount,CommerceRecordRisk,CommerceRecordSettlement,CommerceExpireOrder,
  CommerceRecordPayment,CommerceRequestRefund,CommerceApproveGuestRefund,CommerceApplyExternalRefund,CommerceCompleteRefund,CommerceConfirmOfflineRefund,CommerceClaimTask,CommerceFinishTask,CommerceRetryTask,CommerceResendNotice,CommerceIssueAccess] as const;
