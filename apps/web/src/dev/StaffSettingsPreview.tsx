import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { SessionContext } from '@/lib/session';
import { LanguageProvider } from '@/LanguageContext';
import { supabase } from '@/lib/supabase';
import { StaffSettings } from '@/features/staff/StaffSettings';
import { SetupSaveProvider } from '@/features/setup/autosave';
import { apiGet, setActiveMembershipId } from '@/lib/api';
import type { StaffItem } from '@/features/settings/types';
import { Store, Users, Scissors, Phone, CreditCard, CalendarDays, Settings, ChevronLeft } from 'lucide-react';
import type { ComponentProps } from 'react';

const me='11111111-1111-4111-8111-111111111111';
const make=(id:string,name:string,owner=false):StaffItem=>({membershipId:id,name,roleKeys:[owner?'owner':'tech'],isBookable:true,maxConcurrent:1,levelKey:null,inRotation:false,phoneE164:owner?'+12125550100':'+12125550123',hasAccount:owner,liveSessions:0});
const seed=[make(me,'Amy',true),make('22222222-2222-4222-8222-222222222222','Lily'),make('33333333-3333-4333-8333-333333333333','David')];
const hours=Object.fromEntries(['mon','tue','wed','thu','fri','sat'].map(day=>[day,{open:'10:00',close:'20:00'}]));
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
const session={membershipId:me,status:'ready',isOnline:true,can:()=>true,context:{locale:'zh-Hans',timezone:'America/New_York'},membership:{membershipId:me,roleKeys:['owner']}} as unknown as ComponentProps<typeof SessionContext.Provider>['value'];

/** Local visual fixture: all API calls stay in memory. Never contacts a live shop. */
export default function StaffSettingsPreview(){
 const [ready,setReady]=useState(false);
 useEffect(()=>{
  let staff=[...seed];const timeOff:Record<string,any[]>={[seed[1]!.membershipId]:[{id:'44444444-4444-4444-8444-444444444444',startDate:'2026-10-01',endDate:'2026-10-05',note:'家庭旅行'}]};const schedules:Record<string,unknown>={};
  const originalFetch=window.fetch,originalSession=supabase.auth.getSession;
  supabase.auth.getSession=async()=>({data:{session:{access_token:'local-preview-only'}},error:null}) as any;
  setActiveMembershipId(me);
  window.fetch=async(input,init)=>{
   const url=new URL(String(input),location.origin),body=typeof init?.body==='string'?JSON.parse(init.body):{},v=body.input??{};
   if(url.pathname.includes('/v1/commands/')){
    const command=url.pathname.split('/').at(-1);
    if(command==='staff.saveTimeOff'){const list=timeOff[v.membershipId]??[];timeOff[v.membershipId]=list.filter(l=>l.id!==v.id);if(!v.remove)timeOff[v.membershipId]!.push(v);}
    if(command==='staff.setEmployment')staff=staff.filter(s=>s.membershipId!==v.membershipId);
    if(command==='staff.saveProfile'){if(v.membershipId)staff=staff.map(s=>s.membershipId===v.membershipId?{...s,name:v.name??s.name,phoneE164:v.phone??s.phoneE164,isBookable:v.isBookable??s.isBookable}:s);else staff.push({...make(crypto.randomUUID(),v.name),isBookable:v.isBookable});}
    if(command==='staff.saveBookingSchedule')schedules[v.membershipId]=v.hours;
    return Response.json({ok:true,output:{saved:true,membershipId:v.membershipId??staff.at(-1)?.membershipId}});
   }
   if(url.pathname.endsWith('/staff/booking-schedules'))return Response.json({hours,schedules,timeOff});
   if(url.pathname.endsWith('/staff/list'))return Response.json({staff:staff.map(s=>({...s,id:s.membershipId,phone:s.phoneE164,jobTitleId:null,levelId:null,skillIds:[],maxConcurrentAppointments:1})),jobs:[],levels:[],skills:[]});
   if(url.pathname.endsWith('/settings'))return Response.json({staff});
   return Response.json({code:'LOCAL_PREVIEW_ONLY'},{status:404});
  };
  setReady(true);
  return()=>{window.fetch=originalFetch;supabase.auth.getSession=originalSession;setActiveMembershipId(null);client.clear();};
 },[]);
 if(!ready)return null;
 return <QueryClientProvider client={client}><LanguageProvider><SessionContext.Provider value={session}><BrowserRouter><SetupSaveProvider><PreviewContent/></SetupSaveProvider></BrowserRouter></SessionContext.Provider></LanguageProvider></QueryClientProvider>;
}
function PreviewContent(){
 const q=useQuery({queryKey:['desk','settings',me],queryFn:()=>apiGet<{staff:StaffItem[]}>('/v1/desk/settings')});
 return <div className="min-h-screen bg-slate-50 text-slate-900"><aside className="fixed inset-y-0 hidden w-56 border-r border-slate-200 bg-white p-5 lg:block"><div className="flex items-center gap-3 py-3 font-bold"><span className="rounded-xl bg-teal-50 p-2 text-teal-700">G</span>Zhi Zi Massage</div><div className="mt-10 space-y-5 text-sm text-slate-500"><p className="flex gap-3"><CalendarDays size={18}/>日程安排</p><p className="flex gap-3"><Phone size={18}/>AI 语音助手</p><p className="flex gap-3 rounded-xl bg-teal-50 p-3 text-teal-800"><Settings size={18}/>系统设置</p></div><p className="absolute bottom-8 text-xs text-slate-400">本地样式预览 · 示例数据</p></aside><main className="lg:ml-56"><div className="flex h-20 items-center justify-between border-b border-slate-200 bg-white px-6"><span className="text-sm text-slate-400">系统设置 / 员工与容量</span><span className="rounded-full bg-teal-50 px-3 py-1 text-xs text-teal-700">本地预览</span></div><div className="mx-auto max-w-7xl px-5 py-8 sm:px-8"><header className="mb-7 border-b border-slate-200 pb-6"><h1 className="text-2xl font-bold">系统设置</h1><p className="mt-2 text-sm text-slate-500">管理门店、服务项目和员工。</p></header><div className="grid items-start gap-6 xl:grid-cols-[180px_minmax(0,1fr)]"><nav className="flex gap-2 overflow-auto rounded-2xl border border-slate-200 bg-white p-2 xl:flex-col">{[[Store,'门店'],[Scissors,'服务项目'],[Users,'员工与容量'],[Phone,'电话与通知'],[CreditCard,'套餐与账单']].map(([Icon,label])=>{const I=Icon as typeof Store;return <span key={String(label)} className={`flex shrink-0 items-center gap-3 rounded-xl p-3 text-sm ${label==='员工与容量'?'bg-teal-50 font-semibold text-teal-800':'text-slate-500'}`}><I size={17}/>{String(label)}</span>;})}</nav><div><h2 className="text-xl font-semibold">员工与容量</h2><p className="mb-6 mt-2 text-sm text-slate-500">管理员工、每周排班与休假，清楚掌握谁能接待预约。</p><StaffSettings staff={q.data?.staff??[]} voiceOnly/></div></div></div></main></div>;
}
