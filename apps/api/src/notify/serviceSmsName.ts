import { pickText } from '@gf/contracts';
import type { OwnerLocale } from '../email/locale';
import { notificationCopy } from './copy';

/** A catalog name often already contains its duration. The booked duration is
 * rendered separately, so never repeat that suffix in a notification. */
export function withoutServiceDuration(value:string):string {
  return value.replace(/\s*[（(]?\s*\d+(?:\.\d+)?\s*(?:minutes?|mins?|min\.?|分钟|分鐘|分|분|phút|minutos?|hours?|hrs?|hr|小时|小時)\s*[)）]?\s*$/iu,'').trim();
}
const standardNames:Array<{match:RegExp;names:Record<OwnerLocale,string>}>= [
  {match:/^(?:couples?\s+(?:massage|treatment)|双人按摩|雙人按摩|情侣按摩|情侶按摩)$/iu,
    names:{en:'Couples','zh-Hans':'双人','zh-Hant':'雙人',ko:'커플',vi:'Cặp đôi',es:'Pareja'}},
  {match:/^(?:hot\s+stones?(?:\s+(?:massage|add-on))?|热石|熱石)$/iu,
    names:{en:'Stone','zh-Hans':'热石','zh-Hant':'熱石',ko:'핫스톤',vi:'Đá nóng',es:'Piedra'}},
];
export function smsServiceName(name:unknown,shortNames:Record<string,string>,locale:OwnerLocale):string {
  const stored=shortNames[locale]?.trim();
  if(stored)return withoutServiceDuration(stored)||stored;
  // Known shared services still have readable localized labels before AI fills
  // the catalog. Arbitrary custom names are preserved rather than guessed.
  const values=typeof name==='string'?[name]:name&&typeof name==='object'?Object.values(name):[];
  const known=standardNames.find(entry=>values.some(v=>typeof v==='string'&&entry.match.test(withoutServiceDuration(v))));
  if(known)return known.names[locale];
  return withoutServiceDuration(pickText(name,locale,notificationCopy(locale).service)) || notificationCopy(locale).service;
}
