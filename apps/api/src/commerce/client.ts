import Stripe from 'stripe';
import {stripeClient} from '../stripe/client';
import {commerceLiveMode} from './config';
let cached:Stripe|null=null,cachedKey:string|null=null;
/** A dedicated commerce sandbox never changes the platform SaaS/AI billing credentials. */
export function commerceStripeClient():Stripe {
  commerceLiveMode();
  const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim();
  if(!key)return stripeClient();
  if(!cached||cachedKey!==key){cached=new Stripe(key,{timeout:20_000,maxNetworkRetries:2});cachedKey=key;}
  return cached;
}
