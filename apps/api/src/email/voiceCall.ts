import { notificationCopy } from '../notify/copy';
import { intlLocale, type OwnerLocale } from './locale';
import { formatPhoneDisplay } from '@gf/contracts';
import { emailHeading, emailDetailTable, emailButton, wrapEmailHtml, escapeHtml, nl2brHtml } from './layout';
import type { VoiceTurn } from '../voice/transcript';
export function renderVoiceCallEmail(input: {
  locale: OwnerLocale;
  shop: string; from: string; startedAt?: string | undefined; timezone: string; durationSeconds: number;
  summary: string; turns: VoiceTurn[]; detailUrl: string;
}) {
  const c = notificationCopy(input.locale), title = c.call;
  const time = input.startedAt ? new Intl.DateTimeFormat(intlLocale(input.locale), { timeZone: input.timezone,
    dateStyle: 'medium', timeStyle: 'short' }).format(new Date(input.startedAt)) : '—';
  const rows: Array<[string,string]> = [[c.caller, formatPhoneDisplay(input.from) || c.unknown],
    [c.callTime, `${time} · ${input.timezone}`], [c.duration, `${Math.floor(input.durationSeconds/60)} ${c.minutes} ${input.durationSeconds%60} ${c.seconds}`]];
  const label = (t: VoiceTurn) => t.role === 'assistant' ? c.receptionist : t.role === 'user' ? c.customer : t.speaker !== undefined ? `${c.speaker} ${t.speaker+1}` : c.transcript;
  const stamp = (t: VoiceTurn) => t.startSeconds === undefined ? '' : `${Math.floor(t.startSeconds/60).toString().padStart(2,'0')}:${Math.floor(t.startSeconds%60).toString().padStart(2,'0')}`;
  // Keep the email scannable; the authenticated call page contains the full conversation.
  const preview = input.turns.slice(0,6);
  const conversation = preview.map(t => `<div style="margin:0 0 12px;padding:14px 16px;border-radius:12px;background:${t.role==='assistant'?'#F2FAF3':'#F5F5F7'}">`
    + `<p style="margin:0 0 5px;font-size:12px;color:#6B7A76">${escapeHtml(label(t))} · ${stamp(t)}</p>`
    + `<p style="margin:0;font-size:14px;line-height:1.7">${nl2brHtml(t.text.slice(0,600))}${t.text.length>600?'…':''}</p></div>`).join('');
  const inner = emailHeading(input.shop, title) + emailDetailTable(rows)
    + `<p style="margin:0 0 8px;font-weight:600">${c.summary}</p><p style="margin:0 0 20px">${nl2brHtml(input.summary || c.emptySummary)}</p>`
    + emailButton(input.detailUrl, c.callOpen)
    + `<p style="font-size:12px;color:#6B7A76;margin:8px 0 24px">${c.login}</p>`
    + (preview.length ? `<p style="margin:0 0 12px;font-weight:600">${c.preview}</p>${conversation}` : '')
    + (input.turns.length>6 ? `<p style="font-size:13px;color:#6B7A76">${c.fullCall}</p>` : '');
  return { subject: `${input.shop} · ${title}`, html: wrapEmailHtml(inner, { locale:input.locale, preheader:input.summary.slice(0,100) }),
    text: `${input.shop} · ${title}\n${rows.map(([k,v])=>`${k}：${v}`).join('\n')}\n\n${c.summary}\n${input.summary}\n\n${c.callOpen} (${c.login}): ${input.detailUrl}\n\n${preview.map(t=>`${label(t)} ${stamp(t)}\n${t.text.slice(0,600)}`).join('\n\n')}` };
}
