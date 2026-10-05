import {randomUUID} from 'node:crypto';
import {withTenant} from '@gf/db';
import type {CommandContext} from '@gf/contracts';
import {dispatch,type DispatchOptions} from '../bus';
import '../handlers/commerce';

/** Existing asset-use regressions now issue fixtures through recorded test cash sales. Never a Stripe verification. */
export async function dispatchWithCommerceSale<T=unknown>(name:string,raw:unknown,ctx:CommandContext,options:DispatchOptions={}) {
  const moneyCommands=['giftcard.issue','package.issue','marketing.issuePackage','package.redeem','marketing.redeemPackage'];
  const key=options.idempotencyKey??(moneyCommands.includes(name)?randomUUID():undefined);
  let input=raw;
  if(['giftcard.issue','package.issue','marketing.issuePackage'].includes(name)) {
    process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';
    await dispatch('commerce.saveSettings',{salesEnabled:true,depositsEnabled:false,membershipsEnabled:false},ctx,{idempotencyKey:randomUUID()});
    const data=raw as Record<string,any>;
    const price=await withTenant(ctx,async tx=>{
      if(name==='giftcard.issue') {
        if(!data.templateId)return data.salePriceCents??data.faceValueCents;
        const [t]=await tx<{sale_price_cents:number}[]>`select sale_price_cents from gift_card_templates where id=${data.templateId}`;
        return t?.sale_price_cents;
      }
      const [t]=await tx<{price_cents:number}[]>`select price_cents from package_templates where id=${data.templateId}`;
      return data.soldPriceCentsOverride??data.priceCentsSnapshot??t?.price_cents;
    });
    input={...data,businessKey:data.businessKey??key,channel:price===0?'complimentary':'offline',reason:'Isolated regression fixture sale',
      ...(price>0?{offlinePayment:{method:'cash',amountCents:price,reference:`fixture:${key}`}}:{})};
  }
  return dispatch<T>(name,input,ctx,{...options,...(key?{idempotencyKey:key}:{})});
}
