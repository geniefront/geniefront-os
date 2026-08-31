import React, { useMemo, useState } from 'react';
import { Bot, Check, Clock3, RotateCcw, Sparkles, UsersRound } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import type { LanguageCode } from '../types/i18n';

type DemoState = 'ready' | 'confirmed' | 'undone';

const demoLabels: Record<LanguageCode, {
  live: string;
  balance: string;
  waiting: string;
  ready: string;
  busy: string;
  next: string;
  proposal: string;
  proposalBody: string;
  confirmation: string;
  undoNotice: string;
}> = {
  en: {
    live: 'Live front desk', balance: 'Fairness 100%', waiting: '2 waiting', ready: 'Ready', busy: 'In service', next: 'Next up',
    proposal: 'AI proposes. You decide.', proposalBody: 'Two walk-ins need a 60-minute combo. Assign Lily to Room 2 and Kevin to Room 3 without changing their fair-turn position?',
    confirmation: 'Assigned. Both staff cards were updated.', undoNotice: 'Undone. Queue and rooms restored.',
  },
  'zh-CN': {
    live: '前台实时看板', balance: '轮牌公平度 100%', waiting: '2 人等位', ready: '可接客', busy: '服务中', next: '下一位',
    proposal: 'AI 提议，你来决定。', proposalBody: '两位散客需要 60 分钟套餐。建议 Lily 使用 2 号房，Kevin 使用 3 号房，不改变公平轮牌位置。',
    confirmation: '已派单，两位技师任务卡已同步。', undoNotice: '已撤销，队列和房间状态已还原。',
  },
  es: {
    live: 'Recepción en vivo', balance: 'Equidad 100%', waiting: '2 en espera', ready: 'Disponible', busy: 'En servicio', next: 'Siguiente',
    proposal: 'La IA propone. Tú decides.', proposalBody: '¿Asignar dos clientes sin cita a Lily en la sala 2 y Kevin en la sala 3 sin alterar su turno justo?',
    confirmation: 'Asignado. Las tarjetas del personal se actualizaron.', undoNotice: 'Deshecho. La cola y las salas fueron restauradas.',
  },
  ko: {
    live: '실시간 프런트 데스크', balance: '공정성 100%', waiting: '2명 대기', ready: '준비', busy: '서비스 중', next: '다음 순서',
    proposal: 'AI가 제안하고 당신이 결정합니다.', proposalBody: '60분 콤보 워크인 2명을 공정한 순서 변경 없이 Lily는 2번 룸, Kevin은 3번 룸에 배정할까요?',
    confirmation: '배정 완료. 두 직원 카드가 업데이트되었습니다.', undoNotice: '취소됨. 대기열과 룸이 복원되었습니다.',
  },
  vi: {
    live: 'Lễ tân trực tiếp', balance: 'Công bằng 100%', waiting: '2 khách chờ', ready: 'Sẵn sàng', busy: 'Đang phục vụ', next: 'Lượt tiếp',
    proposal: 'AI đề xuất. Bạn quyết định.', proposalBody: 'Hai khách walk-in cần dịch vụ 60 phút. Giao Lily vào phòng 2, Kevin vào phòng 3 mà không đổi thứ tự công bằng?',
    confirmation: 'Đã giao việc. Thẻ nhân viên đã cập nhật.', undoNotice: 'Đã hoàn tác. Hàng đợi và phòng đã khôi phục.',
  },
};

const baseStaff = [
  { name: 'Lily V.', initials: 'LV', turn: '1.0', accent: '#d9f2e8' },
  { name: 'Kevin C.', initials: 'KC', turn: '1.0', accent: '#e4edf8' },
  { name: 'May L.', initials: 'ML', turn: '1.5', accent: '#f8eadd' },
];

export const InteractiveHeroPreview: React.FC = () => {
  const { t, currentLang } = useLanguage();
  const labels = demoLabels[currentLang];
  const [selectedPrompt, setSelectedPrompt] = useState(0);
  const [state, setState] = useState<DemoState>('ready');
  const [staff, setStaff] = useState(baseStaff);

  const statusNotice = useMemo(() => {
    if (state === 'confirmed') return labels.confirmation;
    if (state === 'undone') return labels.undoNotice;
    return null;
  }, [labels, state]);

  const confirm = () => {
    setState('confirmed');
    setStaff((items) => items.map((item, index) => index < 2 ? { ...item, room: `${index + 2}` } : item));
  };

  const undo = () => {
    setState('undone');
    setStaff(baseStaff);
  };

  return (
    <div className="app-frame p-1.5 sm:p-2" aria-label={t.heroPreview.liveTitle}>
      <div className="overflow-hidden rounded-[20px] bg-[#fbfcf9]">
        <div className="flex h-12 items-center justify-between border-b border-[#e4eae5] px-4">
          <div className="flex items-center gap-2.5">
            <span className="demo-pulse h-2 w-2 rounded-full bg-[#17a673]" />
            <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#20383b]">{labels.live}</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-bold text-[#708184]">
            <Clock3 className="h-3.5 w-3.5" />10:24 AM
            <span className="rounded-full bg-[#d9f2e8] px-2 py-1 text-[#096b61]">{labels.balance}</span>
          </div>
        </div>

        <div className="grid md:grid-cols-[1.1fr_0.9fr]">
          <div className="border-b border-[#e4eae5] p-4 md:border-b-0 md:border-r sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-extrabold text-[#20383b]"><UsersRound className="h-4 w-4 text-[#096b61]" />{t.heroPreview.rotationOrder}</div>
              <span className="text-[10px] font-bold text-[#e86f37]">{labels.waiting}</span>
            </div>

            <div className="space-y-2">
              {staff.map((person, index) => (
                <div key={person.name} className={`metric-card flex items-center gap-3 p-2.5 ${index === 0 ? 'ring-1 ring-[#80b9a8]' : ''}`}>
                  <span className="w-4 text-center text-[10px] font-extrabold text-[#8a9998]">{index + 1}</span>
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-[10px] font-extrabold text-[#20383b]" style={{ background: person.accent }}>{person.initials}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-extrabold text-[#20383b]">{person.name}</span>
                    <span className="block text-[9px] font-bold text-[#708184]">Turn {person.turn}{'room' in person ? ` • Room ${person.room}` : ''}</span>
                  </span>
                  <span className={`rounded-full px-2 py-1 text-[9px] font-extrabold ${'room' in person ? 'bg-[#e4edf8] text-[#32628d]' : 'bg-[#edf8f3] text-[#096b61]'}`}>
                    {'room' in person ? labels.busy : index === 0 ? labels.next : labels.ready}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2">
              {['Room 1', 'Room 2', 'Room 3'].map((room, index) => {
                const assigned = state === 'confirmed' && index > 0;
                return (
                  <div key={room} className={`rounded-xl border p-2 text-center ${assigned ? 'border-[#b9d6cc] bg-[#edf8f3]' : 'border-[#e4eae5] bg-white'}`}>
                    <div className="text-[10px] font-extrabold text-[#20383b]">{room}</div>
                    <div className={`mt-0.5 text-[8px] font-bold ${assigned ? 'text-[#096b61]' : 'text-[#8a9998]'}`}>{assigned ? labels.busy : labels.ready}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col bg-[#f4f6f2] p-4 sm:p-5">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#102a2e] text-white"><Bot className="h-4 w-4" /></span>
              <div>
                <div className="text-[11px] font-extrabold text-[#20383b]">{labels.proposal}</div>
                <div className="text-[9px] font-bold uppercase tracking-[0.11em] text-[#708184]">Human approval required</div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#c9d7cf] bg-white p-3.5 text-[11px] font-semibold leading-5 text-[#405659]">
              <Sparkles className="mb-2 h-4 w-4 text-[#e86f37]" />
              {selectedPrompt === 0 ? labels.proposalBody : t.heroPreview.promptSuggestions[selectedPrompt]}
            </div>

            <div className="mt-3 flex gap-2">
              <button type="button" onClick={confirm} className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#096b61] px-3 py-2.5 text-[10px] font-extrabold text-white hover:bg-[#064b46]">
                <Check className="h-3.5 w-3.5" />{t.heroPreview.confirmBtn}
              </button>
              <button type="button" onClick={undo} className="grid w-10 place-items-center rounded-xl border border-[#dfe5df] bg-white text-[#53676a] hover:text-[#096b61]" aria-label={t.heroPreview.undoBtn} title={t.heroPreview.undoBtn}>
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>

            {statusNotice && <div role="status" className="mt-3 rounded-xl border border-[#b9d6cc] bg-[#edf8f3] px-3 py-2 text-[9px] font-bold leading-4 text-[#096b61]">{statusNotice}</div>}

            <div className="mt-auto pt-4">
              <div className="mb-2 text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#8a9998]">{t.aiSection.copilot.badge}</div>
              <div className="flex flex-wrap gap-1.5">
                {t.heroPreview.promptSuggestions.slice(0, 3).map((prompt, index) => (
                  <button key={prompt} type="button" onClick={() => { setSelectedPrompt(index); setState('ready'); }} className={`rounded-full border px-2.5 py-1 text-[9px] font-bold ${selectedPrompt === index ? 'border-[#80b9a8] bg-[#d9f2e8] text-[#096b61]' : 'border-[#dfe5df] bg-white text-[#708184]'}`}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
