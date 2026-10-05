import {spawnSync} from 'node:child_process';import {writeFile} from 'node:fs/promises';
import {serviceRefundText} from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/contracts/src/serviceRefundCopy.ts';
const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js',session='commerce-payout-desk-final';
function run(...args){const r=spawnSync(process.execPath,[cli,'--session',session,...args],{encoding:'utf8'});if(r.status!==0)throw new Error(`Browser ${args[0]} failed: ${r.stderr.slice(0,500)}`);return r.stdout.trim();}
function value(expression){return JSON.parse(run('eval',expression));}
const locales=[['en','English'],['zh-Hans','中文'],['ko','한국어'],['es','Español'],['vi','Tiếng Việt']],reports=[];
for(const [locale,label] of locales){
 if(value('localStorage.getItem("gf.lang")')!==locale){
  if(value('!!document.querySelector("[role=dialog]")'))run('find','first','[role=dialog] button','click');run('snapshot','-i','-s','tbody tr:nth-child(5)');
  if(!value('!!document.querySelector("button:has(svg.lucide-globe)")'))throw new Error('Observed language control missing');
  run('click','button:has(svg.lucide-globe)');const menu=run('snapshot','-i','-s','.z-dropdown');if(!menu.includes(`button "${label}"`))throw new Error('Expected native language missing');
  run('find','role','button','click','--name',label,'--exact');const rowSnapshot=run('snapshot','-i','-s','tbody tr:nth-child(5)');
  if(!value('document.querySelector("tbody tr:nth-child(5)").innerText.includes("ORD-DAE93")'))throw new Error('Original gift service row moved');
  const buttons=[...rowSnapshot.matchAll(/button .*?\[ref=(e\d+)\]/g)];if(!buttons.length)throw new Error('Original refund control absent');run('click','@'+buttons.at(-1)[1]);run('snapshot','-i','-s','[role=dialog]');
 }
 run('wait','--fn','!!document.querySelector("[role=dialog] section") && document.querySelector("[role=dialog] section").innerText.includes("$30.00")');
 const text=value('document.querySelector("[role=dialog] section").innerText');if(!text.includes(serviceRefundText(locale,'gift_card'))||!text.includes(serviceRefundText(locale,'title')))throw new Error('Wrong locale or original refund destination');
 const guards=value('({overflow:document.documentElement.scrollWidth>innerWidth,buttonsInsideDialog:[...document.querySelectorAll("[role=dialog] button")].every(b=>{const r=b.getBoundingClientRect(),d=document.querySelector("[role=dialog]").getBoundingClientRect();return !r.width||(r.left>=d.left&&r.right<=d.right)}),prepaidConversionsDisabled:[...document.querySelectorAll("[role=dialog] select")][0].querySelector("option[value=cash]").disabled&&[...document.querySelectorAll("[role=dialog] select")][0].querySelector("option[value=store_credit]").disabled})');
 if(guards.overflow||!guards.buttonsInsideDialog||!guards.prepaidConversionsDisabled)throw new Error('Native layout or original-source guard failed');
 run('scroll','up','700','--selector','.modal__body');run('screenshot',`/Users/naiyouzhu/siteadmin/geniefront-os/artifacts/customer-commerce/p5-gift-refund-review-${locale}.png`);reports.push({locale,amountCents:3000,originalGiftDestination:true,...guards});
}
const report={at:new Date().toISOString(),nativeBackofficeLocales:reports,traditionalChineseCopyPresent:!!serviceRefundText('zh-Hant','gift_card'),traditionalChineseBackofficeSelectable:false,financialSubmissionPerformed:false};
await writeFile('/Users/naiyouzhu/siteadmin/geniefront-os/artifacts/customer-commerce/p5-refund-native-locales.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
