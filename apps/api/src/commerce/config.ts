import { AppError,ERROR_CODES } from '@gf/contracts';
export function commerceEnabled():boolean { return process.env.GF_CUSTOMER_COMMERCE_ENABLED === '1'; }
export function commerceLiveMode():boolean {
  const live = process.env.COMMERCE_STRIPE_MODE === 'live';
  const key = process.env.COMMERCE_STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_SECRET_KEY || ''; 
  if (!key.startsWith(live ? 'sk_live_' : 'sk_test_')) throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,
    { details:{ service:'stripe_commerce',reason:'mode_key_mismatch' } });
  return live;
}
export function assertCommerceEnabled():void {
  if(!commerceEnabled())throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'customer_commerce_disabled'}});
}
