import {createHash,randomBytes} from 'node:crypto';
import {commerceText,type CommerceTextKey} from '@gf/contracts';
import {escapeHtml} from '../email/layout';
import type {Tx,Ctx,OrderRow} from '../commerce/model';
/** Authorized transaction events enqueue captured/rendered messages in the same tenant transaction. */
export async function queueCommerceNotice(tx:Tx,ctx:Ctx,order:OrderRow,event:'purchase'|'refund'|'reissue'|'delivery',entityId=order.id,amountCents=order.amount_cents){
  const [customer]=order.customer_id?await tx<{email:string|null;locale:string|null}[]>`select email,locale from customers where id=${order.customer_id}`:[];
  const [location]=await tx<{slug:string}[]>`select slug from locations where id=${ctx.locationId}`;
  const requestedLocale=customer?.locale??ctx.locale;
  const locale=['en','zh-Hans','zh-Hant','es','ko','vi'].includes(requestedLocale)?requestedLocale:'en';
  const text=(key:CommerceTextKey)=>commerceText(locale,key);
  const total=new Intl.NumberFormat(locale,{style:'currency',currency:order.currency.toUpperCase()}).format(amountCents/100);
  const [card]=order.kind==='gift_card'&&order.asset_id?await tx<{code:string;credential_version:number}[]>`select code,credential_version from gift_cards where id=${order.asset_id}`:[];
  const withCredential=event!=='refund';
  const heading=event==='refund'?text('refunded'):event==='reissue'?text('cardReissued'):event==='delivery'?text('purchaseDetails'):text('fulfilled');
  async function enqueue(toEmail:string,parts:string[],audience:'buyer'|'recipient') {
    await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,commerce_order_id,commerce_gift_card_id,commerce_credential_version)
      values(${ctx.orgId},${ctx.locationId},'platform_notice',${toEmail},${`${heading} · ${order.snapshot.name}`},
        ${`<p>${parts.map(escapeHtml).join('</p><p>')}</p>`},${parts.join('\n')},${`commerce_${event}_${audience}`},${entityId},${order.id},
        ${withCredential&&card?order.asset_id:null},${withCredential&&card?card.credential_version:null})
      on conflict(entity_type,entity_id,kind) do nothing`;
  }
  if(customer?.email) {
    let accessUrl:string|null=null;
    if(withCredential&&process.env.BOOKING_BASE_URL&&location){
      const token=randomBytes(32).toString('base64url');
      const tokenHash=createHash('sha256').update(token).digest('hex');
      // The buyer's order link must never be sent to a separate gift recipient.
      await tx`insert into commerce_access_tokens(org_id,location_id,order_id,token_hash,expires_at)
        values(${ctx.orgId},${ctx.locationId},${order.id},${tokenHash},now()+interval '7 days')`;
      const base=new URL(process.env.BOOKING_BASE_URL);
      accessUrl=`${base.origin}/${encodeURIComponent(location.slug)}/shop?order=${order.id}#c/${token}`;
    }
    await enqueue(customer.email,[heading,order.snapshot.name,...(event==='reissue'?[]:[`${text('amount')}: ${total}`]),
      ...(withCredential&&card&&!order.snapshot.recipientEmail?[card.code]:[]),...(accessUrl?[accessUrl]:[])],'buyer');
  }
  if(withCredential&&order.kind==='gift_card'&&order.snapshot.recipientEmail&&card) {
    await enqueue(order.snapshot.recipientEmail,[heading,order.snapshot.name,
      ...(order.snapshot.recipientName?[order.snapshot.recipientName]:[]),card.code,
      ...(order.snapshot.recipientNote?[order.snapshot.recipientNote]:[])],'recipient');
  }
}
