import { useLanguage } from '@/LanguageContext';
export type ConversationLine = { role: string; text: string; startSeconds?: number; speaker?: number; at?: string };
export function CallConversation({ lines }: { lines: ConversationLine[] }) {
  const { t } = useLanguage();
  const visible = lines.filter(line => line.role !== 'tool' && line.text.trim());
  return <div className="space-y-4" aria-label={t('bookingTranscript')}>
    {!visible.length && <p className="py-6 text-center text-sm text-slate-500">{t('crm.callNoTranscript')}</p>}
    {visible.map((line,index) => {
      const ai = line.role === 'assistant', customer = line.role === 'user';
      const time = line.startSeconds === undefined ? line.at : `${Math.floor(line.startSeconds/60).toString().padStart(2,'0')}:${Math.floor(line.startSeconds%60).toString().padStart(2,'0')}`;
      return <div key={index} className={`flex ${customer ? 'justify-end' : 'justify-start'}`}>
        <div className={`max-w-[90%] min-w-0 rounded-2xl px-4 py-3 ${ai ? 'bg-teal-50 text-slate-900' : customer ? 'bg-slate-100 text-slate-900' : 'w-full border border-slate-200 text-slate-600'}`}>
          <div className="mb-1.5 flex items-center gap-3 text-xs text-slate-500">
            <span className="font-semibold">{ai ? t('crm.callSpeakerAi') : customer ? t('crm.callSpeakerCustomer') : `${t('bookingTranscript')}${line.speaker !== undefined ? ` · ${line.speaker+1}` : ''}`}</span>
            {time && <span className="font-mono tabular-nums">{time}</span>}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-7">{line.text}</p>
        </div>
      </div>;
    })}
  </div>;
}
