import React, { useEffect, useMemo, useState } from 'react';
import { CalendarCheck2, Check, CheckCircle2, Clock3, Headphones, Languages, Mic, PhoneCall, PhoneForwarded, RotateCcw, ShieldCheck, UserRound } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

type DemoPhase = 'idle' | 'calling' | 'review' | 'booked' | 'handoff';
type CallLanguage = 'en' | 'es' | 'zh';

const interfaceCopy = {
  en: { badge: 'AI Voice Receptionist · Beta', title: 'Turn every inbound call into a confirmed appointment', subtitle: 'See how the AI receptionist answers naturally, transcribes the call, checks live availability and prepares a structured booking for approval.', start: 'Start voice booking demo', restart: 'Replay demo', live: 'Live call', idle: 'Ready for an inbound call', listening: 'Listening and extracting details', review: 'Booking ready for review', booked: 'Appointment confirmed', handoff: 'Transferred to front desk', transcript: 'Live transcript', summary: 'Appointment draft', guest: 'Guest', service: 'Service', time: 'Date & time', resource: 'Staff / room', confirm: 'Confirm appointment', transfer: 'Transfer to front desk', sms: 'Confirmation SMS queued', safe: 'No booking is written until the final confirmation step.', available: 'Availability checked', caller: 'Caller', ai: 'AI receptionist' },
  'zh-CN': { badge: 'AI 语音前台 · Beta', title: '将每一通来电转化为结构化预约', subtitle: 'AI 前台可自然接听顾客来电、实时转写需求、查询可用时段，并生成待确认的标准预约信息。', start: '开始语音预约演示', restart: '重新播放演示', live: '实时通话', idle: '等待顾客来电', listening: '正在聆听并提取预约信息', review: '预约信息等待确认', booked: '预约已确认', handoff: '已转接人工前台', transcript: '实时通话转写', summary: '预约信息草稿', guest: '顾客', service: '服务项目', time: '预约时间', resource: '技师与房间', confirm: '确认创建预约', transfer: '转接人工前台', sms: '确认短信已进入发送队列', safe: '在最终确认前，系统不会写入预约数据。', available: '已核验实时可用性', caller: '顾客', ai: 'AI 前台' },
  vi: { badge: 'Lễ tân giọng nói AI · Beta', title: 'Chuyển mọi cuộc gọi thành lịch hẹn rõ ràng', subtitle: 'AI trả lời tự nhiên, ghi âm hội thoại, kiểm tra lịch trống và tạo bản nháp để xác nhận.', start: 'Bắt đầu bản demo', restart: 'Phát lại', live: 'Cuộc gọi trực tiếp', idle: 'Sẵn sàng nhận cuộc gọi', listening: 'Đang nghe và trích xuất', review: 'Lịch hẹn chờ duyệt', booked: 'Đã xác nhận lịch hẹn', handoff: 'Đã chuyển lễ tân', transcript: 'Bản ghi trực tiếp', summary: 'Bản nháp lịch hẹn', guest: 'Khách', service: 'Dịch vụ', time: 'Ngày và giờ', resource: 'Nhân viên / phòng', confirm: 'Xác nhận lịch hẹn', transfer: 'Chuyển lễ tân', sms: 'SMS xác nhận đang chờ gửi', safe: 'Không ghi lịch hẹn trước bước xác nhận cuối.', available: 'Đã kiểm tra lịch trống', caller: 'Khách', ai: 'Lễ tân AI' },
  ko: { badge: 'AI 음성 프런트 · Beta', title: '모든 전화를 구조화된 예약으로 전환', subtitle: 'AI가 자연스럽게 응대하고 통화를 전사하며 실시간 가능 시간을 확인한 뒤 승인용 예약안을 만듭니다.', start: '음성 예약 데모 시작', restart: '다시 재생', live: '실시간 통화', idle: '수신 전화 대기 중', listening: '듣고 예약 정보 추출 중', review: '예약 검토 대기', booked: '예약 확인 완료', handoff: '프런트로 연결됨', transcript: '실시간 통화 기록', summary: '예약 초안', guest: '고객', service: '서비스', time: '예약 시간', resource: '직원 / 룸', confirm: '예약 확인', transfer: '프런트로 연결', sms: '확인 문자 발송 대기', safe: '최종 확인 전에는 예약 데이터를 저장하지 않습니다.', available: '실시간 가능 여부 확인됨', caller: '고객', ai: 'AI 프런트' },
  es: { badge: 'Recepción de voz con IA · Beta', title: 'Convierte cada llamada en una cita estructurada', subtitle: 'La IA responde con naturalidad, transcribe la llamada, comprueba disponibilidad y prepara una reserva para aprobación.', start: 'Iniciar demo de reserva', restart: 'Repetir demo', live: 'Llamada en vivo', idle: 'Lista para recibir llamadas', listening: 'Escuchando y extrayendo datos', review: 'Reserva lista para revisar', booked: 'Cita confirmada', handoff: 'Transferida a recepción', transcript: 'Transcripción en vivo', summary: 'Borrador de cita', guest: 'Cliente', service: 'Servicio', time: 'Fecha y hora', resource: 'Personal / sala', confirm: 'Confirmar cita', transfer: 'Transferir a recepción', sms: 'SMS de confirmación en cola', safe: 'No se guarda la cita hasta la confirmación final.', available: 'Disponibilidad comprobada', caller: 'Cliente', ai: 'Recepción IA' },
} as const;

const scenarios = {
  en: [
    { role: 'ai', text: 'Thank you for calling Golden Lotus Spa. How may I help you today?' },
    { role: 'caller', text: 'Hi, I need a 60-minute deep tissue massage next Tuesday afternoon.' },
    { role: 'ai', text: 'I can help with that. Would 2:30 PM work for you?' },
    { role: 'caller', text: 'Yes. My name is Sarah, and I prefer a female therapist.' },
    { role: 'ai', text: 'Great. I found Lily in Room 2 at 2:30 PM. May I confirm this appointment?' },
  ],
  es: [
    { role: 'ai', text: 'Gracias por llamar a Golden Lotus Spa. ¿En qué puedo ayudarle?' },
    { role: 'caller', text: 'Quisiera un masaje de tejido profundo de 60 minutos el martes por la tarde.' },
    { role: 'ai', text: 'Tenemos disponibilidad a las 2:30 PM. ¿Le funciona?' },
    { role: 'caller', text: 'Sí. Me llamo Sarah y prefiero una terapeuta.' },
    { role: 'ai', text: 'Perfecto. Lily está disponible en la sala 2. ¿Confirmo la cita?' },
  ],
  zh: [
    { role: 'ai', text: '您好，感谢致电 Golden Lotus Spa，请问需要什么服务？' },
    { role: 'caller', text: '我想预约下周二下午的 60 分钟深层组织按摩。' },
    { role: 'ai', text: '下午 2:30 有可用时段，请问方便吗？' },
    { role: 'caller', text: '可以。我叫 Sarah，希望安排女技师。' },
    { role: 'ai', text: '已找到 Lily，安排在 2 号房。请问确认预约吗？' },
  ],
} as const;

export const AiVoiceBookingDemo: React.FC = () => {
  const { currentLang } = useLanguage();
  const labels = interfaceCopy[currentLang];
  const [callLanguage, setCallLanguage] = useState<CallLanguage>('en');
  const [phase, setPhase] = useState<DemoPhase>('idle');
  const [visibleMessages, setVisibleMessages] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const messages = scenarios[callLanguage];

  useEffect(() => {
    if (phase !== 'calling') return;
    if (visibleMessages >= messages.length) {
      const ready = window.setTimeout(() => setPhase('review'), 600);
      return () => window.clearTimeout(ready);
    }
    const next = window.setTimeout(() => setVisibleMessages((count) => count + 1), visibleMessages === 0 ? 250 : 820);
    return () => window.clearTimeout(next);
  }, [messages.length, phase, visibleMessages]);

  useEffect(() => {
    if (phase !== 'calling') return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const status = phase === 'idle' ? labels.idle : phase === 'calling' ? labels.listening : phase === 'review' ? labels.review : phase === 'booked' ? labels.booked : labels.handoff;
  const duration = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const details = useMemo(() => [
    { icon: UserRound, label: labels.guest, value: 'Sarah M.', readyAt: 4 },
    { icon: Headphones, label: labels.service, value: '60 min · Deep Tissue', readyAt: 2 },
    { icon: Clock3, label: labels.time, value: 'Tue, Sep 8 · 2:30 PM', readyAt: 3 },
    { icon: CalendarCheck2, label: labels.resource, value: 'Lily V. · Room 2', readyAt: 5 },
  ], [labels]);

  const start = () => { setPhase('calling'); setVisibleMessages(0); setSeconds(0); };
  const chooseLanguage = (language: CallLanguage) => { setCallLanguage(language); setPhase('idle'); setVisibleMessages(0); setSeconds(0); };

  return (
    <div className="demo-window mt-8 border-2 border-[#20383b] bg-[#eef1ec]">
      <div className="demo-window-bar">
        <div className="flex items-center gap-3"><span className="demo-icon bg-[#102a2e] text-white"><PhoneCall className="h-4 w-4" /></span><div><div className="text-xs font-extrabold text-[#20383b]">{labels.badge}</div><div className="mt-1 text-[9px] font-bold text-[#708184]">Inbound booking automation</div></div></div>
        <span className="demo-status"><span className={`demo-status-dot ${phase === 'idle' ? '!bg-[#e86f37]' : ''}`} />{status}</span>
      </div>

      <div className="grid lg:grid-cols-[0.95fr_1.05fr]">
        <div className="border-b border-[#dfe5df] bg-[#102a2e] p-5 text-white lg:border-b-0 lg:border-r sm:p-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div><div className="eyebrow !border-white/15 !bg-white/10 !text-[#a6ead6]"><Mic className="h-3.5 w-3.5" />{labels.live}</div><h3 className="mt-4 max-w-lg text-2xl font-bold leading-tight sm:text-3xl">{labels.title}</h3><p className="mt-3 max-w-xl text-xs font-medium leading-6 text-white/55">{labels.subtitle}</p></div>
            <div className="flex shrink-0 items-center gap-1 rounded-xl border border-white/10 bg-white/[.06] p-1"><Languages className="mx-1 h-3.5 w-3.5 text-white/45" />{(['en', 'es', 'zh'] as const).map((language) => <button key={language} type="button" onClick={() => chooseLanguage(language)} aria-pressed={callLanguage === language} className={`rounded-lg px-2.5 py-1.5 text-[9px] font-extrabold uppercase transition ${callLanguage === language ? 'bg-[#55c3a5] text-[#0c292d]' : 'text-white/55 hover:text-white'}`}>{language}</button>)}</div>
          </div>

          <div className="mt-6 overflow-hidden rounded-[22px] border border-white/10 bg-[#081f22] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${phase === 'calling' ? 'demo-pulse bg-[#55c3a5]' : 'bg-white/25'}`} /><span className="text-[10px] font-extrabold text-white/75">+1 (917) 555-0148</span></div><div className="flex items-center gap-3"><div className={`voice-wave ${phase === 'calling' ? '' : 'opacity-20'}`}>{[1,2,3,4,5].map((bar) => <span key={bar} style={{ animationDelay: `${bar * 80}ms` }} />)}</div><span className="font-mono text-[10px] font-bold text-white/45">{duration}</span></div></div>
            <div className="custom-scrollbar h-[260px] space-y-3 overflow-y-auto p-4" aria-live="polite">
              {phase === 'idle' && <div className="grid h-full place-items-center text-center"><div><PhoneCall className="mx-auto h-7 w-7 text-[#55c3a5]" /><p className="mt-3 text-[10px] font-bold text-white/45">{labels.idle}</p></div></div>}
              {messages.slice(0, visibleMessages).map((message, index) => <div key={`${callLanguage}-${index}`} className={`demo-result-enter flex ${message.role === 'caller' ? 'justify-start' : 'justify-end'}`}><div className={`max-w-[86%] rounded-2xl px-3.5 py-2.5 ${message.role === 'caller' ? 'rounded-tl-md bg-white/10 text-white/75' : 'rounded-tr-md bg-[#0d6f64] text-white'}`}><div className="mb-1 text-[8px] font-extrabold uppercase tracking-wider opacity-55">{message.role === 'caller' ? labels.caller : labels.ai}</div><p className="text-[10px] font-semibold leading-5">{message.text}</p></div></div>)}
              {phase === 'calling' && visibleMessages < messages.length && <div className="flex justify-end"><div className="flex gap-1 rounded-full bg-white/10 px-3 py-2">{[1,2,3].map((dot) => <span key={dot} className="demo-pulse h-1.5 w-1.5 rounded-full bg-[#55c3a5]" style={{ animationDelay: `${dot * 120}ms` }} />)}</div></div>}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" onClick={phase === 'idle' ? start : phase === 'booked' || phase === 'handoff' ? start : undefined} disabled={phase === 'calling' || phase === 'review'} className="primary-button !border-[#55c3a5] !bg-[#55c3a5] !text-[#0c292d] disabled:opacity-45">{phase === 'booked' || phase === 'handoff' ? <RotateCcw className="h-4 w-4" /> : <PhoneCall className="h-4 w-4" />}{phase === 'booked' || phase === 'handoff' ? labels.restart : labels.start}</button>
            <button type="button" onClick={() => setPhase('handoff')} disabled={phase === 'idle' || phase === 'booked' || phase === 'handoff'} className="secondary-button !border-white/15 !bg-white/[.06] !text-white disabled:opacity-35"><PhoneForwarded className="h-4 w-4" />{labels.transfer}</button>
          </div>
        </div>

        <div className="bg-[#f7f8f3] p-5 sm:p-7">
          <div className="flex items-center justify-between"><div><h4 className="demo-panel-title"><CalendarCheck2 className="h-4 w-4 text-[#096b61]" />{labels.summary}</h4><p className="mt-1 text-[10px] font-semibold text-[#708184]">{labels.available}</p></div><span className={`demo-chip ${phase === 'booked' ? '!border-[#a9d7c7] !bg-[#e3f5ed] !text-[#096b61]' : ''}`}>{phase === 'booked' ? 'GF-2048 ✓' : 'Draft'}</span></div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {details.map((detail) => { const ready = visibleMessages >= detail.readyAt || phase === 'booked' || phase === 'handoff'; return <div key={detail.label} className={`rounded-2xl border p-4 transition-all duration-300 ${ready ? 'border-[#d7e3dd] bg-white shadow-sm' : 'border-[#e4eae5] bg-[#eef1ec]'}`}><div className="flex items-center gap-2 text-[9px] font-extrabold uppercase tracking-wider text-[#8a9998]"><detail.icon className={`h-3.5 w-3.5 ${ready ? 'text-[#096b61]' : 'text-[#aab6b4]'}`} />{detail.label}</div>{ready ? <div className="demo-result-enter mt-3 text-xs font-extrabold text-[#20383b]">{detail.value}</div> : <div className="mt-3 h-3 w-3/4 animate-pulse rounded-full bg-[#dfe5df]" />}</div>; })}
          </div>

          <div className="mt-4 rounded-2xl border border-[#dfe5df] bg-white p-4"><div className="flex items-center justify-between"><span className="text-[10px] font-extrabold text-[#20383b]">{labels.available}</span><span className={`rounded-full px-2 py-1 text-[9px] font-extrabold ${visibleMessages >= 5 || phase === 'booked' ? 'bg-[#e3f5ed] text-[#096b61]' : 'bg-[#f0f2ef] text-[#8a9998]'}`}>{visibleMessages >= 5 || phase === 'booked' ? '✓ 2:30 PM' : '—'}</span></div><div className="mt-3 grid grid-cols-4 gap-1.5">{['1:30', '2:00', '2:30', '3:00'].map((time) => <span key={time} className={`rounded-lg border px-1 py-2 text-center text-[9px] font-bold ${time === '2:30' && (visibleMessages >= 5 || phase === 'booked') ? 'border-[#80b9a8] bg-[#edf8f3] text-[#096b61]' : 'border-[#e4eae5] text-[#8a9998]'}`}>{time}</span>)}</div></div>

          {phase === 'review' && <div className="demo-result-enter mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2"><button type="button" onClick={() => setPhase('booked')} className="primary-button"><Check className="h-4 w-4" />{labels.confirm}</button><button type="button" onClick={() => setPhase('handoff')} className="secondary-button"><PhoneForwarded className="h-4 w-4" />{labels.transfer}</button></div>}
          {phase === 'booked' && <div role="status" className="demo-result-enter mt-4 rounded-2xl border border-[#a9d7c7] bg-[#e3f5ed] p-4"><div className="flex items-center gap-3 text-xs font-extrabold text-[#096b61]"><CheckCircle2 className="h-5 w-5" />{labels.booked}</div><p className="mt-2 text-[10px] font-semibold text-[#4e746d]">{labels.sms}</p></div>}
          {phase === 'handoff' && <div role="status" className="demo-result-enter mt-4 rounded-2xl border border-[#e9c7a9] bg-[#fff4e8] p-4"><div className="flex items-center gap-3 text-xs font-extrabold text-[#9b542f]"><PhoneForwarded className="h-5 w-5" />{labels.handoff}</div></div>}
          <div className="mt-5 flex items-start gap-2 border-t border-[#dfe5df] pt-4 text-[10px] font-semibold leading-5 text-[#708184]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#096b61]" />{labels.safe}</div>
        </div>
      </div>
    </div>
  );
};
