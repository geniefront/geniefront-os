// Frontend-only print QA against Web Vite on port 5187. Synthetic data only.
import { chromium, webkit, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const out = new URL('../artifacts/print-review/', import.meta.url).pathname;
await mkdir(out, {recursive:true});
const fixture = {
  store:{name:'SAMPLE — American Wellness Studio',timezone:'America/New_York',phone:'(212) 555-0100',address:['123 Sample Avenue','New York NY 10001'],footer:'SAMPLE DOCUMENT — NOT A REAL TRANSACTION\nThank you for your visit!'},
  order:{ticketId:'11111111-1111-4111-8111-111111111111',businessDate:'2026-09-09',status:'closed',customerName:'Sample Guest',customerPhone:null,customerId:null,openedAt:'2026-09-10T02:00:00Z',closedAt:'2026-09-10T03:00:00Z',subtotalCents:10000,discountCents:500,taxCents:842,surchargeCents:0,tipCents:2000,totalCents:12342,refundCents:1000,refundTipCents:0,refundTaxCents:0,refundFeeCents:0,
  items:[{itemId:'1',name:'Therapeutic massage — long service name wrapping check',kind:'service',quantity:2,unitPriceCents:5000,totalCents:10000,staffName:null,membershipId:null}],payments:[{paymentId:'p',method:'card',amountCents:12342,cardLast4:'4242'}],tipAllocations:[]},
};
for(const [name,engine] of Object.entries({chromium,webkit})) {
 const browser = await engine.launch();
 try {
  const page = await browser.newPage({hasTouch:true, viewport:{width:820,height:1180}});
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.route('**/src/lib/supabase.ts*', route=>route.fulfill({contentType:'application/javascript',body:`export const supabase = {auth:{getSession:async()=>({data:{session:{access_token:'synthetic-test-token'}}})}};`}));
  await page.route('**/src/lib/session.tsx*', route=>route.fulfill({contentType:'application/javascript',body:`
    const noop=()=>{};
    const session={status:'ready',activePortal:'admin',membershipId:'test-membership',isOnline:true,isPureTech:false,isTechCapable:false,locations:[],membership:{locationName:{en:'Sample store'},roleKeys:['owner'],status:'active'},context:{timezone:'America/New_York',businessDayCutoff:'00:00',permissions:[]},session:{user:{email:'sample@example.invalid'}},can:()=>true,clearMembership:noop,signOut:noop,switchPortal:noop};
    export const useSession=()=>session; export const SessionProvider=({children})=>children;
  `}));
  await page.route('**/v1/**', route=>route.request().url().endsWith('/receipt') ? route.fulfill({json:fixture,headers:{'Cache-Control':'no-store'}}):route.abort());
  await page.goto(`http://127.0.0.1:5187/print/receipt/${fixture.order.ticketId}`);
  await expect(page.getByText(fixture.store.name)).toBeVisible();
  await page.getByRole('button',{name:'Print / Save PDF',exact:true}).click();
  const preview=page.locator('#gf-print-root');
  await expect(preview.getByRole('button',{name:'Print / Save PDF',exact:true})).toBeEnabled();
  expect(await page.locator('.gf-print-sheet').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:`${out}${name}-receipt.png`});
  if(name==='chromium') await page.pdf({path:`${out}receipt-80mm.pdf`,width:'80mm',height:'11in',printBackground:true,preferCSSPageSize:true});
  // 58mm 热敏也要验：美甲店用的多是这一档，而它比 80mm 窄近三成，
  // 长项目名与「小计/税/小费」那几行最先在这里溢出。
  await page.getByLabel('Paper size').selectOption('thermal58');
  expect(await page.locator('.gf-print-sheet').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  if(name==='chromium') await page.pdf({path:`${out}receipt-58mm.pdf`,width:'58mm',height:'11in',printBackground:true,preferCSSPageSize:true});
  await page.getByLabel('Paper size').selectOption('thermal');
  await page.getByLabel('Paper size').selectOption('letter');
  if(name==='chromium') await page.pdf({path:`${out}receipt-letter.pdf`,printBackground:true,preferCSSPageSize:true});
  await page.evaluate(()=>{window.print=()=>{window.__printCalls=(window.__printCalls||0)+1;}});
  await preview.getByRole('button',{name:'Print / Save PDF',exact:true}).click();
  expect(await page.evaluate(()=>window.__printCalls)).toBe(1);
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  await expect(preview).toBeVisible();
  await preview.getByRole('button',{name:'Close preview'}).click();
  await expect(preview).toHaveCount(0);
  await page.evaluate(async()=>{
    const {printTable}=await import('/src/features/printing/preview.ts');
    printTable('SAMPLE order statement (USD)', ['Receipt','Customer','Total'],Array.from({length:120},(_,i)=>[`Sample ${i+1}`,i===119?'LAST ROW — 120':'Sample customer','$100.00']));
  });
  await expect(page.locator('.gf-print-sheet tbody tr')).toHaveCount(120);
  if(name==='chromium') await page.pdf({path:`${out}statement-letter.pdf`,printBackground:true,preferCSSPageSize:true});
  await page.keyboard.press('Escape');
  await expect(page.locator('#gf-print-root')).toHaveCount(0);
  await page.evaluate(async()=>{
    const ReactModule = await import('/node_modules/.vite/deps/react.js');
    const React = ReactModule.default ?? ReactModule;
    const ReactDOM = await import('/node_modules/.vite/deps/react-dom_client.js');
    const {createRoot} = ReactDOM.default ?? ReactDOM;
    const {QRCodeZoomModal} = await import('/src/components/QRCodeZoomModal.tsx');
    const moduleText = await (await fetch('/src/components/QRCodeZoomModal.tsx')).text();
    const languagePath = moduleText.match(/from ["']([^"']*LanguageContext[^"']*)["']/)[1];
    const {LanguageProvider} = await import(languagePath);
    const host=document.createElement('div'); document.body.append(host);
    const root=createRoot(host);
    root.render(React.createElement(LanguageProvider, null, React.createElement(QRCodeZoomModal,{isOpen:true,url:'https://example.com/sample',title:'Sample QR print',onClose:()=>{root.unmount();host.remove();}})));
  });
  await page.waitForTimeout(500);
  await page.getByRole('button',{name:/^打印$|^Print$/}).click({timeout:3000});
  await expect(page.locator('#gf-print-root svg').first()).toBeVisible();
  await expect(page.locator('#gf-print-root').getByRole('button',{name:'Print / Save PDF',exact:true})).toBeEnabled();
  await page.emulateMedia({media:'print'});
  await page.screenshot({path:`${out}${name}-qr-print.png`});
  await page.emulateMedia({media:'screen'});
  await page.locator('#gf-print-root').getByRole('button',{name:'Close preview'}).click();
  expect(errors).toEqual([]);
  console.log(`PASS ${name}: receipt, Letter/80mm/58mm, 120 rows, cancel/reprint and close`);
 } finally {await browser.close();}
}
