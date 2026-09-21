import { SERVICE_SHORT_NAME_LOCALES, type ServiceShortNames } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Field } from '@/features/setup/primitives';
import type { Language } from '@/i18n/types';
const copy:Record<Language,{label:string;hint:string;generate:string;bulk:string;done:string;changed:string}>={
 en:{label:'SMS short names',hint:'Prefer 2 characters where clear; up to 12. AI fills all six languages without replacing existing values. Uses AI credits.',generate:'AI fill all languages',bulk:'AI fill missing short names',done:'Short names saved',changed:'Some services changed during generation and were skipped.'},
 'zh-Hans':{label:'短信简称',hint:'尽量两个字，最多12个字符。AI补齐六种语言，保留已有值，使用AI额度。',generate:'AI补齐全部语言',bulk:'AI批量补齐简称',done:'简称已保存',changed:'部分项目在生成期间被修改，已跳过。'},
 ko:{label:'문자용 약칭',hint:'가능하면 2자, 최대 12자. AI가 기존 값을 유지하며 6개 언어를 채웁니다. AI 크레딧이 사용됩니다.',generate:'AI로 모든 언어 채우기',bulk:'AI로 누락된 약칭 채우기',done:'약칭 저장 완료',changed:'생성 중 변경된 서비스는 건너뛰었습니다.'},
 vi:{label:'Tên ngắn cho SMS',hint:'Ưu tiên 2 ký tự nếu rõ nghĩa, tối đa 12. AI bổ sung 6 ngôn ngữ và giữ giá trị đã có. Sử dụng tín dụng AI.',generate:'AI bổ sung mọi ngôn ngữ',bulk:'AI bổ sung tên ngắn còn thiếu',done:'Đã lưu tên ngắn',changed:'Đã bỏ qua dịch vụ bị thay đổi trong lúc tạo.'},
 es:{label:'Nombres cortos para SMS',hint:'Preferiblemente 2 caracteres si se entiende; máximo 12. La IA completa seis idiomas sin reemplazar valores. Usa créditos de IA.',generate:'IA: completar todos los idiomas',bulk:'IA: completar nombres cortos',done:'Nombres cortos guardados',changed:'Se omitieron servicios modificados durante la generación.'},
};
export function useShortNameCopy(){return copy[useLanguage().language];}
const labels={'en':'English','zh-Hans':'简体中文','zh-Hant':'繁體中文',ko:'한국어',vi:'Tiếng Việt',es:'Español'};
export function ShortNameFields({value,onChange,onGenerate,busy,canGenerate}:{value:ServiceShortNames;onChange:(v:ServiceShortNames)=>void;onGenerate:()=>void;busy:boolean;canGenerate:boolean}) {
 const c=useShortNameCopy();
 return <section className="space-y-3 rounded-xl border border-slate-200 p-4">
   <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{c.label}</h4><Button type="button" size="sm" variant="secondary" disabled={!canGenerate||busy} isPending={busy} onClick={onGenerate}>{c.generate}</Button></div>
   <p className="text-sm text-slate-500">{c.hint}</p>
   <div className="grid gap-3 sm:grid-cols-2">{SERVICE_SHORT_NAME_LOCALES.map(l=><Field key={l} label={labels[l]}><Input aria-label={`${c.label} · ${labels[l]}`} maxLength={24} disabled={busy} value={value[l]??''} onChange={e=>onChange({...value,[l]:e.target.value})}/></Field>)}</div>
 </section>;
}
