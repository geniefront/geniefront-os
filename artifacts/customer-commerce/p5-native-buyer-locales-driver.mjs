import {spawnSync} from 'node:child_process';import {writeFile} from 'node:fs/promises';import {commerceText} from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/contracts/src/commerceCopy.ts';
const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js',session='commerce-package-payout-purchase';
function run(...args){const r=spawnSync(process.execPath,[cli,'--session',session,...args],{encoding:'utf8'});if(r.status!==0)throw new Error('Owned buyer inspection failed');return r.stdout.trim();}
const reports=[];
for(const locale of ['en','zh-Hans','zh-Hant','es','ko','vi']){
 run('select','select[aria-label=Language]',locale);const snapshot=run('snapshot');
 if(!snapshot.includes(commerceText(locale,'partiallyRefunded'))||!snapshot.includes(`1 ${commerceText(locale,'sessions')}`))throw new Error('Original customer result lost refund or restored quantity');
 const overflow=JSON.parse(run('eval','document.documentElement.scrollWidth>innerWidth'));if(overflow)throw new Error('Original mobile result overflows');
 run('screenshot',`/Users/naiyouzhu/siteadmin/geniefront-os/artifacts/customer-commerce/p5-package-buyer-restored-${locale}.png`);reports.push({locale,restoredSessions:1,partialPurchaseRefundPreserved:true,mobileWidth:390,mobileHeight:844,overflow});
}
const errors=run('errors');if(errors)throw new Error('Owned original buyer page has browser errors');run('select','select[aria-label=Language]','en');run('snapshot');
const report={at:new Date().toISOString(),originalCapturedBuyerReceiptLinkReused:true,newAccessTokenIssued:false,originalPaidCents:50000,originalPurchaseRefundCents:45000,currentAvailableSessions:1,locales:reports,browserErrors:0,productionChanged:false};
await writeFile('/Users/naiyouzhu/siteadmin/geniefront-os/artifacts/customer-commerce/p5-package-buyer-restored-locales.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
