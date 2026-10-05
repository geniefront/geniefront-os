import {readFileSync} from 'node:fs';
import {test,expect,type Page} from '@playwright/test';
const p=JSON.parse(readFileSync(process.env.COMMERCE_E2E_PROFILE_PATH!,'utf8'));
test.beforeEach(async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(()=>localStorage.setItem('booking_locale','en'));
 (page as Page&{qaErrors?:string[]}).qaErrors=errors;
});
test.afterEach(async({page})=>{expect((page as Page&{qaErrors?:string[]}).qaErrors).toEqual([]);});
async function openPrivate(page:Page,url:string){try{await page.goto(url);}catch{throw new Error('Protected local QA page failed to load');}}
async function layout(page:Page){await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);await expect(page.locator('body')).not.toContainText('⟦');}
test('public purchase catalog offers six languages on desktop and mobile',async({page})=>{
 await page.goto(`${p.bookingBase}/${p.slug}/shop`);
 await expect(page.getByRole('heading',{level:1})).toContainText('Gift');
 const language=page.getByRole('combobox',{name:'Language'});await expect(language.locator('option')).toHaveCount(6);
 for(const locale of ['en','zh-Hans','zh-Hant','es','vi','ko']){await language.selectOption(locale);await page.setViewportSize({width:390,height:844});await layout(page);}
 await page.screenshot({path:'artifacts/customer-commerce/p6-e2e-catalog-mobile.png'});
});
test('paid amended booking shows only the surviving service and exact $2 deposit',async({page})=>{
 await openPrivate(page,p.paidUrl);await expect(page.getByRole('heading',{name:'Your appointment',exact:true})).toBeVisible();
 const deposit=page.getByRole('region',{name:'Deposit paid',exact:true});
 await expect(deposit).toContainText('Available paid deposit$2');await expect(deposit).toContainText('Remaining service amount before tax and tip$8');
 await expect(page.locator('.managed-summary')).not.toContainText('$80');await layout(page);
 await page.setViewportSize({width:390,height:844});await page.getByRole('combobox').selectOption('zh-Hans');await layout(page);
 await page.screenshot({path:'artifacts/customer-commerce/p6-e2e-paid-mobile-zh.png'});
});
test('naturally expired reservation has no payment action after page closure',async({page})=>{
 await openPrivate(page,p.expiredUrl);await expect(page.getByRole('region',{name:'Reservation expired'})).toBeVisible();
 await expect(page.locator('a[href*="checkout.stripe.com"]')).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});await page.getByRole('combobox').selectOption('zh-Hant');
 await expect(page.getByRole('region',{name:'保留時段已過期'})).toBeVisible();await layout(page);
 await page.screenshot({path:'artifacts/customer-commerce/p6-e2e-expired-mobile-hant.png'});
});
test('original $500 package receipt retains its restored unit and $450 purchase refund',async({page})=>{
 await openPrivate(page,p.packageUrl);await expect(page.locator('body')).toContainText('$500.00');
 await expect(page.locator('body')).toContainText('$450.00');await expect(page.locator('body')).toContainText('1 sessions');
 await page.getByRole('combobox',{name:'Language'}).selectOption('zh-Hant');await layout(page);
 await page.screenshot({path:'artifacts/customer-commerce/p6-e2e-package-hant.png'});
});
test('refunded unlimited receipt stays inactive instead of advertising zero usable sessions',async({page})=>{
 await openPrivate(page,p.unlimitedUrl);await expect(page.locator('body')).toContainText('This package cannot be used.');
 await expect(page.locator('body')).toContainText('$500.00');await expect(page.locator('a[href*="checkout.stripe.com"]')).toHaveCount(0);await layout(page);
});
test('ended original membership retains protected invoice history and six-language access',async({page})=>{
 await openPrivate(page,p.membershipUrl);await expect(page.locator('body')).toContainText('Subscription ended');
 await expect(page.getByRole('button',{name:/View invoices/})).toBeVisible();
 await page.getByRole('combobox',{name:'Language'}).selectOption('zh-Hant');await layout(page);
 await page.screenshot({path:'artifacts/customer-commerce/p6-e2e-membership-hant.png'});
});
test('desk switches to Traditional Chinese and disables writes while offline',async({browser})=>{
 const context=await browser.newContext({storageState:p.identities.owner});const page=await context.newPage();
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 try{await page.goto(`${p.deskBase}/commerce`);await expect(page.getByRole('heading',{name:'Customer payments',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Language',exact:true}).click();await page.getByRole('button',{name:'繁體中文',exact:true}).click();
  await expect(page.getByRole('heading',{name:'顧客收款',exact:true})).toBeVisible();await layout(page);
  await page.screenshot({path:'artifacts/customer-commerce/p6-e2e-desk-hant.png'});
  await context.setOffline(true);await expect(page.getByRole('button',{name:'儲存計畫版本',exact:true})).toBeDisabled();
  expect(errors).toEqual([]);
 }finally{await context.close();}
});
