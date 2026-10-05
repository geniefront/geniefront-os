import {z} from 'zod';
import {defineCommand,uuid} from '../command.js';
const money=z.number().int().min(0).max(1_000_000_000);
const metadata={ai:{description:'Paid customer membership',confirm:'always' as const,exposed:false},reversible:false,idempotency:'required' as const,
 auditRedact:['amountCents','token','stripeCustomerId']};
const privateCommand={...metadata,system:true};
export const customerMembershipTerms=z.object({
 name:z.record(z.string().min(1).max(120)).refine(v=>!!v.en,'English name required'),
 amountCents:money.positive(),cadence:z.enum(['month','year']),benefitFrequency:z.enum(['month','billing_period']).default('month'),
 quantity:z.number().int().min(0).max(1000),serviceIds:z.array(uuid).max(100),
 discountBps:z.number().int().min(0).max(10000).default(0),discountServiceIds:z.array(uuid).max(100).default([]),
 commissionBasis:z.enum(['catalog_price','sale_price','zero']).default('sale_price'),
}).superRefine((v,c)=>{
 if(v.quantity>0&&!v.serviceIds.length)c.addIssue({code:'custom',path:['serviceIds'],message:'Choose covered services'});
 if(v.discountBps>0&&!v.discountServiceIds.length)c.addIssue({code:'custom',path:['discountServiceIds'],message:'Choose discounted services'});
 if(v.quantity===0&&v.discountBps===0)c.addIssue({code:'custom',message:'Membership requires a benefit'});
 if(new Set(v.serviceIds).size!==v.serviceIds.length||new Set(v.discountServiceIds).size!==v.discountServiceIds.length)c.addIssue({code:'custom',message:'Duplicate services'});
});
export type CustomerMembershipTerms=z.infer<typeof customerMembershipTerms>;
export const CommerceSaveMembershipPlan=defineCommand({...metadata,name:'commerce.saveMembershipPlan',permission:'commerce.configure',
 input:z.object({planId:uuid.optional(),expectedVersion:z.number().int().positive().optional(),terms:customerMembershipTerms,active:z.boolean(),onlineSale:z.boolean()}),
 output:z.object({planId:uuid,versionId:uuid,version:z.number().int().positive()})});
export const membershipEnrollmentInput=z.object({versionId:uuid,businessKey:z.string().min(8).max(160),
 customer:z.object({name:z.string().trim().min(1).max(120),email:z.string().email().max(200)}),
 consent:z.object({accepted:z.literal(true),versionId:uuid,amountCents:money.positive(),cadence:z.enum(['month','year'])}),
}).refine(v=>v.versionId===v.consent.versionId,'Confirm the selected plan version');
export const CommerceEnrollMembership=defineCommand({...privateCommand,name:'commerce.enrollMembership',input:membershipEnrollmentInput,
 output:z.object({membershipId:uuid,orderId:uuid})});
export const CommerceBindMembershipCustomer=defineCommand({...privateCommand,name:'commerce.bindMembershipCustomer',
 input:z.object({membershipId:uuid,stripeAccountId:z.string(),livemode:z.boolean(),stripeCustomerId:z.string().regex(/^cus_[A-Za-z0-9_]+$/)}),output:z.object({bound:z.boolean()})});
export const membershipProviderFact=z.object({membershipId:uuid,stripeAccountId:z.string(),livemode:z.boolean(),
 stripeCustomerId:z.string(),subscriptionId:z.string(),priceId:z.string(),status:z.enum(['incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused']),
 cancelAtPeriodEnd:z.boolean(),currentPeriodEnd:z.string().datetime(),currentPeriodStart:z.string().datetime().optional(),observedAt:z.string().datetime(),
 cancelAt:z.string().datetime().nullable().default(null),providerCancelAtPeriodEnd:z.boolean().optional(),
 eventId:z.string().min(1).max(200),eventType:z.string().min(1).max(100)});
export const CommerceRecordMembershipState=defineCommand({...privateCommand,name:'commerce.recordMembershipState',input:membershipProviderFact,
 output:z.object({recorded:z.boolean()})});
export const CommerceRecordMembershipInvoice=defineCommand({...privateCommand,name:'commerce.recordMembershipInvoice',input:membershipProviderFact.extend({
 invoiceId:z.string().min(1).max(200),invoicePriceId:z.string().optional(),paymentIntentId:z.string().min(1),amountCents:money.positive(),currency:z.string().regex(/^[a-z]{3}$/),
 periodStart:z.string().datetime(),periodEnd:z.string().datetime(),paidAt:z.string().datetime(),
 }),output:z.object({invoiceId:uuid,orderId:uuid,duplicate:z.boolean()})});
export const CommerceGrantMembershipCycles=defineCommand({...privateCommand,name:'commerce.grantMembershipCycles',input:z.object({membershipId:uuid}),
 output:z.object({issued:z.number().int().nonnegative(),nextRunAfterSec:z.number().int().min(5).max(86400).optional()})});
const invoiceRefunds=z.array(z.object({invoiceId:uuid,amountCents:money.positive()})).max(24);
const reviewHash=z.string().regex(/^[a-f0-9]{64}$/);
export const CommerceTerminateMembership=defineCommand({...metadata,name:'commerce.terminateMembership',permission:'commerce.refund',
 input:z.object({membershipId:uuid,expectedReviewHash:reviewHash,unusedBenefits:z.enum(['revoke_all','keep_current_paid']),refunds:invoiceRefunds,
  reason:z.string().trim().min(2).max(500),confirmed:z.literal(true)}),output:z.object({terminationId:uuid,status:z.string()}),
 auditRedact:['refunds.*.amountCents','expectedReviewHash']});
export const CommerceRefundMembership=defineCommand({...metadata,name:'commerce.refundMembership',permission:'commerce.refund',
 input:z.object({membershipId:uuid,terminationId:uuid,expectedReviewHash:reviewHash,refunds:invoiceRefunds.min(1),reason:z.string().trim().min(2).max(500),confirmed:z.literal(true)}),
 output:z.object({requestId:uuid,refundIds:z.array(uuid)}),auditRedact:['refunds.*.amountCents','expectedReviewHash']});
export const CommerceCompleteMembershipTermination=defineCommand({...privateCommand,name:'commerce.completeMembershipTermination',
 input:membershipProviderFact.extend({terminationId:uuid,providerCanceledAt:z.string().datetime()}).refine(v=>v.status==='canceled','Verify actual cancellation'),
 output:z.object({terminationId:uuid,status:z.string()})});
export const CommerceAuthorizeMembershipPortal=defineCommand({...privateCommand,name:'commerce.authorizeMembershipPortal',input:z.object({
 membershipId:uuid,tokenHash:z.string().regex(/^[a-f0-9]{64}$/),
}),output:z.object({authorized:z.literal(true)})});
export const membershipChangeInput=z.object({versionId:uuid,businessKey:uuid,expectedPeriodEnd:z.string().datetime(),
 consent:z.object({accepted:z.literal(true),versionId:uuid,amountCents:money.positive(),cadence:z.enum(['month','year']),effectiveAt:z.string().datetime()})});
export const CommerceRequestMembershipChange=defineCommand({...privateCommand,name:'commerce.requestMembershipChange',input:membershipChangeInput.extend({membershipId:uuid,tokenHash:z.string().regex(/^[a-f0-9]{64}$/)}),output:z.object({changeId:uuid,status:z.string()})});
export const CommerceBindMembershipChange=defineCommand({...privateCommand,name:'commerce.bindMembershipChange',input:z.object({changeId:uuid,stripeAccountId:z.string(),livemode:z.boolean(),subscriptionId:z.string(),stripePriceId:z.string(),stripeScheduleId:z.string(),effectiveAt:z.string().datetime(),scheduled:z.boolean()}),output:z.object({recorded:z.boolean()})});
export const membershipChangeWithdrawalInput=z.object({businessKey:uuid,confirmed:z.literal(true)});
export const CommerceWithdrawMembershipChange=defineCommand({...privateCommand,name:'commerce.withdrawMembershipChange',input:membershipChangeWithdrawalInput.extend({membershipId:uuid,changeId:uuid,tokenHash:z.string().regex(/^[a-f0-9]{64}$/)}),output:z.object({changeId:uuid,status:z.string()})});
export const CommerceCompleteMembershipChangeWithdrawal=defineCommand({...privateCommand,name:'commerce.completeMembershipChangeWithdrawal',input:z.object({changeId:uuid,stripeAccountId:z.string(),livemode:z.boolean(),subscriptionId:z.string(),previousPriceId:z.string(),releasedScheduleId:z.string().nullable()}),output:z.object({recorded:z.boolean()})});
export const membershipAccessInput=z.object({membershipId:uuid,action:z.enum(['reissue','revoke']),expectedVersion:z.number().int().positive(),expectedEmail:z.string().email().max(200).optional(),reason:z.string().trim().min(2).max(500),confirmed:z.literal(true)});
export const CommerceManageMembershipAccess=defineCommand({...metadata,name:'commerce.manageMembershipAccess',permission:'commerce.configure',input:membershipAccessInput,output:z.object({accessVersion:z.number().int().positive(),noticeQueued:z.boolean(),expiresAt:z.string().datetime().nullable()}),auditRedact:['expectedEmail']});
export const CUSTOMER_MEMBERSHIP_COMMANDS=[CommerceManageMembershipAccess,CommerceWithdrawMembershipChange,CommerceCompleteMembershipChangeWithdrawal,CommerceRequestMembershipChange,CommerceBindMembershipChange,CommerceSaveMembershipPlan,CommerceEnrollMembership,CommerceBindMembershipCustomer,
 CommerceRecordMembershipState,CommerceRecordMembershipInvoice,CommerceGrantMembershipCycles,CommerceAuthorizeMembershipPortal,
 CommerceTerminateMembership,CommerceRefundMembership,CommerceCompleteMembershipTermination] as const;
