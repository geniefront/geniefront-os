import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const out='/tmp/gf-frontdesk-review'; await mkdir(out,{recursive:true});
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)});
await page.route('**/src/lib/session.tsx*',r=>r.fulfill({contentType:'application/javascript',body:`const noop=()=>{}; export const useSession=()=>({status:'ready',membershipId:'test',isOnline:true,can:()=>true,context:{timezone:'America/New_York',permissions:[]},locations:[],session:null});export const SessionProvider=({children})=>children;`}));
await page.route('**/src/lib/navigation.ts*',r=>r.fulfill({contentType:'application/javascript',body:`export const useOpenInternalRoute=()=>()=>{};`}));
await page.route('**/v1/**',r=>r.fulfill({json:{forms:[]}}));
await page.goto('http://127.0.0.1:5187');
await page.evaluate(async()=>{
 const React=(await import('/node_modules/.vite/deps/react.js')).default;
 const ReactDOM=await import('/node_modules/.vite/deps/react-dom_client.js'); const {createRoot}=ReactDOM.default ?? ReactDOM;
 const source=await (await fetch('/src/features/schedule/appointmentDetail.ts')).text();
 const queryPath=source.match(/from ["']([^"']*tanstack_react-query[^"']*)["']/)[1];
 const {QueryClient,QueryClientProvider}=await import(queryPath);
 const modalSource=await (await fetch('/src/pages/queue/modals/CheckInModal.tsx')).text();
 const languagePath=modalSource.match(/from ["']([^"']*LanguageContext[^"']*)["']/)[1];
 const {LanguageProvider}=await import(languagePath);
 const {CheckInModal}=await import('/src/pages/queue/modals/CheckInModal.tsx');
 const {StartServiceModal}=await import('/src/pages/queue/modals/StartServiceModal.tsx');
 const {CheckoutModal}=await import('/src/pages/queue/modals/CheckoutModal.tsx');
 const {CompleteServiceModal}=await import('/src/pages/queue/modals/CompleteServiceModal.tsx');
 const item={id:'sample',appointmentId:null,customerName:'Sample Guest',serviceName:'Massage',serviceId:'s',durationMin:60,priceCents:10000,staffId:'staff',staffName:'Amy',ticketId:'ticket',stage:'checked_in',notes:'',addOns:[]};
 const services=[{id:'s',name:'Massage',priceCents:10000,durationMin:60,requiredSkills:[],staffCount:1}];
 const staff=[{membershipId:'staff',name:'Amy',isBookable:true,skills:[],status:'available'}];
 const room={id:'r',name:'Room 1',status:'cleaning',rawStatus:'cleaning_required',capacity:1,type:'room',waitingCleaningCount:1};
 const text={'zh-Hans':'请确认客户填写的注意事项',en:'Confirm reported concerns',ko:'확인',es:'Confirmar',vi:'Xác nhận'};
 const lines={'zh-Hans':['客户报告对精油过敏'],en:['Customer reports oil allergy'],ko:[],es:[],vi:[]};
 const summary={riskLevel:'moderate',headline:text,keyAlerts:lines,avoidAreasList:{...lines,'zh-Hans':['右膝'],en:['Right knee']},focusNotes:{...text,'zh-Hans':'力度未提供',en:'Pressure not provided'},technicianAdvice:text};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const noop=()=>{};
 const configs={
 checkin:[CheckInModal,{state:{isOpen:true,item,contraindications:['none'],massageStrength:'medium',aromaOil:'none',focusAreas:[],avoidAreas:[],notes:'',selectedAddOnId:'',addOnStaffId:''},services,staff,completedForms:[{submissionId:'form',templateKey:'massage_intake',templateTitle:{en:'Intake','zh-Hans':'健康问卷'}}],aiSummary:summary,aiSummarySubmissionId:'form',language:'zh-Hans',isSummaryLoading:false,isSummaryFailed:false,onPickSummary:noop,onOpenFormQr:noop,onCopyFormLink:noop,onClearError:noop}],
 start:[StartServiceModal,{state:{isOpen:true,item,assignments:[{serviceId:'s',serviceName:'Massage',durationMin:60,staffCount:1,staffIds:['staff'],roomId:''}],staffId:'staff',roomId:'',addedAddOns:[],serviceBrief:'',startTime:'14:00',serviceDurationMin:60},services,staff,rooms:[room],onlineTechIds:new Set(),rotationEntries:[],scheduledItems:[],cleaningRoomIds:new Set(),onCleanDone:()=>{window.__cleanDone=true},onBeginCleaning:()=>{window.__cleanStarted=true},onAddAddOn:noop}],
 checkout:[CheckoutModal,{state:{isOpen:true,item,paymentStage:'service',discountDollars:'0',taxRatePercent:'8.8750',enableCardSurcharge:false,cardSurchargePercent:'3.0',paymentMethod:'card',tipMode:'total_split',tipPercentage:15,totalTipDollars:'',customStaffTips:{},splitStrategy:'proportional'},allowTipSplitOverride:true,checkoutSettings:{taxCalculationMode:'exclusive'}}],
 complete:[CompleteServiceModal,{state:{isOpen:true,item,addedAddOns:[],extraAddOnServiceId:'',extraAddOnStaffId:'',roomId:'',markRoomCleaning:true,technicianNotes:''},services,staff,rooms:[room]}],
 };
 window.__show=(name)=>{const [Component,props]=configs[name];root.render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(LanguageProvider,null,React.createElement(Component,{...props,isPending:false,onChange:noop,onConfirm:()=>{window.__confirmed=true}}))));};
});
for(const name of ['checkin','start','checkout','complete']){
 await page.evaluate(name=>window.__show(name),name);
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.getByRole('dialog')).toContainText(({checkin:'顾客到店',start:'分配工位',checkout:'108.88',complete:'完工'})[name]);
 await page.waitForTimeout(450);
 await page.screenshot({animations:'disabled',path:`${out}/${name}.png`});
 expect(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 if(name==='start'){
  await page.getByRole('button',{name:/开始打扫|Start cleaning/}).click();expect(await page.evaluate(()=>window.__cleanStarted)).toBe(true);
  await page.getByRole('button',{name:/打扫完|清洁完成|Cleaned|cleaning complete|已打扫/i}).click();expect(await page.evaluate(()=>window.__cleanDone)).toBe(true);
 }
 if(name==='checkout') await expect(page.getByRole('dialog')).toContainText('108.88');
}
expect(errors).toEqual([]);
await browser.close();console.log(`Verified four dialogs, room cleaning actions and checkout total. Screenshots: ${out}`);
