import { useEffect, useState } from 'react';
import { PlanSummary } from '../pages/BookingExperiencePage';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, Shell, Topbar } from '../components/Chrome';
import { SuccessStep } from '../pages/BookPage';
import { ManageBody } from '../pages/ManageBookingPage';
import type { ManagedBooking, Shop } from '../lib/api';
import { calendarHref } from '../lib/calendar';

const shop: Shop = {
  name:'Lotus Spa & Beauty Wellness',slug:'lotus-spa-nyc',timezone:'America/New_York',currency:'USD',businessDayCutoff:'03:00',
  publicKey:'pk_local_preview',phone:'+12125550100',address:null,businessHours:{},locales:['en'],turnstileSiteKey:null,
  onlineBooking:{enabled:true,maxDaysAhead:60,minMinutesAhead:120,requirePhoneVerification:false,cancelCutoffHours:4},
};
const booking: ManagedBooking = {
  bookingId:'local-preview',status:'booked',startsAt:'2026-09-23T14:30:00Z',endsAt:'2026-09-23T15:15:00Z',timezone:shop.timezone,
  durationMin:45,priceCents:4500,specialistName:null,
  items:[{serviceId:'preview-service',name:'Gel Manicure',addonIds:[],addonNames:[],startsAt:'2026-09-23T14:30:00Z',endsAt:'2026-09-23T15:15:00Z',durationMin:45,priceCents:4500,specialistName:null}],
  policy:{cancelCutoffHours:4,rescheduleEnabled:true,rescheduleCutoffHours:4,selfRescheduleMax:2},
  actions:{canCancel:true,canReschedule:true,canRebook:true,reason:null,rescheduleCountLeft:2},
};

/** Development-only visual fixture. No production appointment or token is used. */
export default function AppointmentPreview() {
 const [params,setParams]=useSearchParams();
 const edit=params.get('view')==='edit';
 const [currentBooking,setCurrentBooking]=useState(booking);
 useEffect(()=>{
  const original=window.fetch;
  window.fetch=async (input,init)=>{
   const body=typeof init?.body==='string' ? JSON.parse(init.body) : {};
   if(body.manageToken!=='local-preview-only') return original(input,init);
   const url=String(input);
   if(url.endsWith('/hosted/availability')) return Response.json({date:body.date,timezone:shop.timezone,durationMin:45,canReschedule:true,reason:null,staff:[],slots:[14,15,16,17,18,19,20].map(h=>({startsAt:`${body.date}T${h}:30:00.000Z`,staff:null}))});
   if(body.last4!=='1234') return Response.json({error:'PERMISSION_DENIED',details:{reason:'last4_mismatch',attemptsLeft:2}},{status:403});
   if(url.endsWith('/cancel')) setCurrentBooking(b=>({...b,status:'cancelled',actions:{...b.actions,canCancel:false,canReschedule:false}}));
   if(url.endsWith('/reschedule')) setCurrentBooking(b=>({...b,startsAt:body.startsAt,endsAt:new Date(Date.parse(body.startsAt)+45*60000).toISOString(),items:b.items.map(i=>({...i,startsAt:body.startsAt,endsAt:new Date(Date.parse(body.startsAt)+45*60000).toISOString()}))}));
   return Response.json({bookingId:'local-preview',status:'booked',startsAt:body.startsAt});
  };
  return ()=>{window.fetch=original;};
 },[]);
 return <Shell><Topbar shop={shop} step={null}/>
  <nav style={{display:'flex',gap:16,justifyContent:'center',fontSize:12,marginTop:20}} aria-label="Local preview">
   <Link to="/__preview/appointment">Confirmation preview</Link><Link to="/__preview/appointment?view=edit">Edit preview</Link>
  </nav>
  {edit ? <div className="manage-layout"><ManageBody shop={shop} booking={currentBooking} token="local-preview-only" slug={shop.slug}/></div> :
   <div className="success-layout" onClick={event=>{const link=(event.target as HTMLElement).closest('a');if(link?.getAttribute('href')?.startsWith('/l/')){event.preventDefault();setParams({view:'edit'});}}}><SuccessStep shop={shop} slug={shop.slug} done={{bookingId:booking.bookingId,manageToken:"local-preview-only"}} calendarUrl={calendarHref(booking,shop)} onAgain={()=>setParams({view:'edit'})}>
    <PlanSummary shop={shop} staff={[]} plan={{startsAt:booking.startsAt,items:[{guestIndex:0,serviceId:'preview-service',addonIds:[],staffId:null,startsAt:booking.startsAt,endsAt:booking.endsAt,durationMin:45,priceCents:4500}]}} catalog={{categories:[],addons:[],services:[{id:'preview-service',name:'Gel Manicure',description:null,durationMin:45,priceCents:4500,categoryId:null,isAddon:false,staffCount:1}]}}/>

    <Card><h2 className="section-label">Contact</h2><p>Alex Morgan</p><p>+1 212 555 1234</p></Card>
   </SuccessStep></div>}
 </Shell>;
}
