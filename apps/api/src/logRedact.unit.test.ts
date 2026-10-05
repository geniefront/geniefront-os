import Fastify from 'fastify';
import {it,expect} from 'vitest';
import {redactRequestUrl,LOGGER_REDACT_PATHS} from './logRedact';
it('preserves ordinary routing while removing gift-card and purchase bearer credentials from logs',()=>{
  const input='/v1/desk/giftcards/verify?code=PRIVATE_TEST_CREDENTIAL&limit=20&token=PRIVATE_TEST_TOKEN';
  const result=redactRequestUrl(input);
  expect(result).toContain('/v1/desk/giftcards/verify?');expect(result).toContain('limit=20');
  expect(result).not.toContain('PRIVATE_TEST_CREDENTIAL');expect(result).not.toContain('PRIVATE_TEST_TOKEN');
  expect(redactRequestUrl('/v1/desk/giftcards/verify?%63ode=PRIVATE_TEST_CREDENTIAL')).not.toContain('PRIVATE_TEST_CREDENTIAL');
  expect(LOGGER_REDACT_PATHS).toContain('req.headers["x-gf-commerce-token"]');
});

it('redacts gift credentials inside single and grouped checkout request bodies',async()=>{
 const output:string[]=[];const server=Fastify({logger:{serializers:{req:value=>({body:value.body})},redact:{paths:[...LOGGER_REDACT_PATHS],censor:'[redacted]'},stream:{write:(value:string)=>{output.push(value);}}}});const log=server.log;
 log.info({req:{body:{input:{payments:[{giftCardCode:'PRIVATE_PAY',amountCents:100}],storedValuePayments:[{giftCardCode:'PRIVATE_QUOTE',amountCents:200}],ticketSelections:[{ticketId:'ticket',storedValuePayments:[{giftCardCode:'PRIVATE_GROUP',amountCents:300}]}]}}}});
 const serialized=output.join('');expect(serialized).not.toMatch(/PRIVATE_(PAY|QUOTE|GROUP)/);expect(serialized).toContain('[redacted]');expect(serialized).toContain('"ticketId":"ticket"');await server.close();
});
