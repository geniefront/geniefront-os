import { formatPhoneDisplay } from '@gf/contracts';
import { emailHeading, emailDetailTable, emailButton, wrapEmailHtml, escapeHtml, nl2brHtml } from './layout';
import type { VoiceTurn } from '../voice/transcript';
export function renderVoiceCallEmail(input: {
  shop: string; from: string; startedAt?: string | undefined; timezone: string; durationSeconds: number;
  summary: string; turns: VoiceTurn[]; detailUrl: string;
}) {
  const title = '来电记录';
  const time = input.startedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: input.timezone,
    dateStyle: 'medium', timeStyle: 'short' }).format(new Date(input.startedAt)) : '—';
  const rows: Array<[string,string]> = [['来电号码', formatPhoneDisplay(input.from) || '未知号码'],
    ['来电时间', `${time} · ${input.timezone}`], ['通话时长', `${Math.floor(input.durationSeconds/60)} 分 ${input.durationSeconds%60} 秒`]];
  const label = (t: VoiceTurn) => t.role === 'assistant' ? 'AI 接待' : t.role === 'user' ? '客户' : t.speaker !== undefined ? `说话人 ${t.speaker+1}` : '转录';
  const stamp = (t: VoiceTurn) => t.startSeconds === undefined ? '' : `${Math.floor(t.startSeconds/60).toString().padStart(2,'0')}:${Math.floor(t.startSeconds%60).toString().padStart(2,'0')}`;
  // Keep the email scannable; the authenticated call page contains the full conversation.
  const preview = input.turns.slice(0,6);
  const conversation = preview.map(t => `<div style="margin:0 0 12px;padding:14px 16px;border-radius:12px;background:${t.role==='assistant'?'#F2FAF3':'#F5F5F7'}">`
    + `<p style="margin:0 0 5px;font-size:12px;color:#6B7A76">${escapeHtml(label(t))} · ${stamp(t)}</p>`
    + `<p style="margin:0;font-size:14px;line-height:1.7">${nl2brHtml(t.text.slice(0,600))}${t.text.length>600?'…':''}</p></div>`).join('');
  const inner = emailHeading(input.shop, title) + emailDetailTable(rows)
    + `<p style="margin:0 0 8px;font-weight:600">通话摘要</p><p style="margin:0 0 20px">${nl2brHtml(input.summary || '暂无摘要')}</p>`
    + emailButton(input.detailUrl, '查看对话与录音')
    + `<p style="font-size:12px;color:#6B7A76;margin:8px 0 24px">需登录门店账号查看。</p>`
    + (preview.length ? `<p style="margin:0 0 12px;font-weight:600">对话预览</p>${conversation}` : '')
    + (input.turns.length>6 ? '<p style="font-size:13px;color:#6B7A76">完整对话见通话详情。</p>' : '');
  return { subject: `${input.shop} · ${title}`, html: wrapEmailHtml(inner, { zh:true, preheader:input.summary.slice(0,100) }),
    text: `${input.shop} · ${title}\n${rows.map(([k,v])=>`${k}：${v}`).join('\n')}\n\n通话摘要\n${input.summary}\n\n查看对话与录音（需登录）：${input.detailUrl}\n\n${preview.map(t=>`${label(t)} ${stamp(t)}\n${t.text.slice(0,600)}`).join('\n\n')}` };
}
