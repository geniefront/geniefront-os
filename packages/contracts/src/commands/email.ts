import {z} from 'zod';
import {defineCommand} from '../command.js';
export const RequestEmailDomain=defineCommand({
 name:'email.requestDomain',permission:'settings.manage',idempotency:'required',reversible:false,
 ai:{description:'Request an appointment sender domain and DNS setup instructions.',confirm:'always'},
 input:z.object({domain:z.string().min(3).max(253),managedBy:z.enum(['platform','customer'])}),
 output:z.object({requestId:z.string().uuid()}),
});
export const SetEmailSender=defineCommand({
 name:'email.setSender',permission:'settings.manage',idempotency:'required',reversible:true,
 ai:{description:'Select a verified appointment sender domain or restore the platform sender.',confirm:'always'},
 input:z.object({useCustom:z.boolean(),requestId:z.string().uuid().nullable().default(null),
 fromLocal:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/).default('booking'),replyTo:z.string().email().max(254).nullable().default(null)}),
 output:z.object({saved:z.boolean()}),
});
export const RecheckEmailDomain=defineCommand({
 name:'email.recheckDomain',permission:'settings.manage',idempotency:'optional',reversible:false,
 ai:{description:'Schedule DNS verification for an existing domain request.',confirm:'never'},
 input:z.object({requestId:z.string().uuid()}),output:z.object({queued:z.boolean()}),
});
export const ValidateCustomerEmails=defineCommand({
 name:'email.validateCustomers',permission:'settings.manage',idempotency:'required',reversible:false,
 ai:{description:'Validate existing customer email addresses without sending email.',confirm:'always'},
 input:z.object({emails:z.array(z.string().email().max(254)).min(1).max(25)}),
 output:z.object({queued:z.number()}),
});
export const EMAIL_COMMANDS=[ValidateCustomerEmails,RequestEmailDomain,SetEmailSender,RecheckEmailDomain];
