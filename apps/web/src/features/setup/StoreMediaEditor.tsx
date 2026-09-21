import {useQueryClient} from '@tanstack/react-query';
import {publicBookingProfileSchema} from '@gf/contracts';
import {useDeskSettingsQuery} from '@/features/settings/api';
import type {DeskSettings} from '@/features/settings/types';
import {useSession} from '@/lib/session';
import {apiGet,runCommand} from '@/lib/api';
import {BookingImagePicker} from '@/components/ui/BookingImagePicker';
import {ImageUploader} from '@/components/ui/ImageUploader';
import {useLanguage} from '@/LanguageContext';
import {SaveStatus,useSetupDraft} from './autosave';
export function StoreMediaEditor(){
 const {data}=useDeskSettingsQuery(),qc=useQueryClient(),{membershipId}=useSession(),{language}=useLanguage();
 const zh=language.startsWith('zh');const profile=data?publicBookingProfileSchema.parse(data.publicBookingProfile??{}):null;
 const draft=useSetupDraft(profile?{description:profile.description,coverUrl:profile.coverUrl,photoUrls:profile.photoUrls}:null,async media=>{
  const current=await apiGet<DeskSettings>('/v1/desk/settings');
  const parsed=publicBookingProfileSchema.safeParse({...current.publicBookingProfile,...media});
  if(!parsed.success)throw new Error(zh?'图片地址必须是有效的 HTTPS 链接，请重新上传图片。':'Use valid HTTPS image links. Please upload the image again.');
  await runCommand('location.savePublicBookingProfile',parsed.data,membershipId!);
  await qc.invalidateQueries({queryKey:['desk','settings']});
 });
 if(!draft.value)return null;const v=draft.value;
 return <details className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6"><summary className="cursor-pointer font-semibold">{zh?'门店图片与简介':'Shop photos and description'}</summary><div className="mt-4 space-y-4">
 <label className="block text-sm">{zh?'门店简介':'About the shop'}<textarea className="mt-2 w-full rounded-xl border p-3" maxLength={3000} value={v.description} onChange={e=>draft.set(old=>({...old,description:e.target.value}))}/></label>
 <div className="max-w-lg"><BookingImagePicker label={zh?'封面':'Cover'} value={v.coverUrl} onChange={coverUrl=>draft.set(old=>({...old,coverUrl}))}/></div>
 <div className="grid gap-3 sm:grid-cols-3">{[...v.photoUrls,...(v.photoUrls.length<8?['']:[])].map((url,i)=><ImageUploader key={i} bucket="store_logos" aspectRatio="wide" maxWidth={1200} maxHeight={900} label={`${zh?'照片':'Photo'} ${i+1}`} value={url} onChange={url=>draft.set(old=>{const photoUrls=[...old.photoUrls];if(url)photoUrls[i]=url;else photoUrls.splice(i,1);return {...old,photoUrls};})}/>)}</div><SaveStatus {...draft}/></div></details>;
}
