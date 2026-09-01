import React, { useEffect, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { uiText } from '../translations/ui';
import { 
  Smartphone, 
  Tablet, 
  Check, 
  AlertCircle, 
  Volume2, 
  Clock, 
  Sparkles, 
  User, 
  FileSignature, 
  ShieldCheck,
  Languages
} from 'lucide-react';

export const StaffPwaAndKioskSection: React.FC = () => {
  const { t, currentLang } = useLanguage();
  const ui = uiText[currentLang];
  const [selectedStaffLang, setSelectedStaffLang] = useState<'vi' | 'zh' | 'en' | 'es' | 'ko'>(currentLang === 'zh-CN' ? 'zh' : currentLang);
  const [isChimeActive, setIsChimeActive] = useState(false);
  const [serviceSeconds, setServiceSeconds] = useState(48 * 60 + 15);
  const [servicePhase, setServicePhase] = useState<'assigned' | 'active' | 'complete'>('assigned');
  const [kioskSubmitted, setKioskSubmitted] = useState(false);

  // Interactive Pain Map Body Points
  const [selectedPainPoints, setSelectedPainPoints] = useState<string[]>(['neck', 'lowerBack']);
  const [selectedPressure, setSelectedPressure] = useState<'Soft' | 'Medium' | 'Deep / Firm'>('Deep / Firm');
  const staffLabels = {
    vi: { ring: 'Thử chuông', chiming: 'Đang phát chuông 🔔', turn: 'Lượt hiện tại', round: '1,0 lượt', assigned: 'Đã giao việc', active: 'Đang phục vụ', complete: 'Đã hoàn thành', start: 'Bắt đầu', done: 'Hoàn thành', reset: 'Đặt lại' },
    zh: { ring: '测试提示音', chiming: '正在播放提示音 🔔', turn: '当前轮次', round: '1.0 轮', assigned: '等待开始', active: '服务进行中', complete: '服务已完成', start: '开始服务', done: '完成服务', reset: '重置演示' },
    en: { ring: 'Test chime', chiming: 'Chiming 🔔', turn: 'Turn count', round: '1.0 round', assigned: 'Assigned', active: 'In service', complete: 'Completed', start: 'Start service', done: 'Complete', reset: 'Reset demo' },
    es: { ring: 'Probar aviso', chiming: 'Sonando 🔔', turn: 'Turno actual', round: '1,0 turno', assigned: 'Asignado', active: 'En servicio', complete: 'Completado', start: 'Iniciar', done: 'Completar', reset: 'Reiniciar' },
    ko: { ring: '알림음 테스트', chiming: '알림음 재생 중 🔔', turn: '현재 순번', round: '1.0회', assigned: '배정됨', active: '서비스 중', complete: '완료됨', start: '서비스 시작', done: '완료', reset: '초기화' },
  }[selectedStaffLang];
  const kioskLabels = {
    en: { mode: 'iPad kiosk mode', parts: ['Head & scalp', 'Neck & shoulders', 'Lower back', 'Feet / soles'], pressure: ['Soft', 'Medium', 'Deep / firm'], submit: 'Submit intake', submitted: 'Intake synced to front desk', steps: ['Profile', 'Preferences', 'Consent'] },
    'zh-CN': { mode: 'iPad 自助登记模式', parts: ['头部与头皮', '颈部与肩部', '腰部', '足部与足底'], pressure: ['轻柔', '适中', '较强'], submit: '提交登记信息', submitted: '登记信息已同步至前台', steps: ['基本信息', '服务偏好', '知情同意'] },
    vi: { mode: 'Chế độ kiosk iPad', parts: ['Đầu và da đầu', 'Cổ và vai', 'Lưng dưới', 'Bàn chân'], pressure: ['Nhẹ', 'Vừa', 'Mạnh'], submit: 'Gửi thông tin', submitted: 'Đã đồng bộ tới lễ tân', steps: ['Hồ sơ', 'Sở thích', 'Đồng ý'] },
    ko: { mode: 'iPad 키오스크 모드', parts: ['머리와 두피', '목과 어깨', '허리', '발과 발바닥'], pressure: ['약하게', '보통', '강하게'], submit: '접수 제출', submitted: '프런트에 동기화됨', steps: ['정보', '선호도', '동의'] },
    es: { mode: 'Modo kiosco de iPad', parts: ['Cabeza y cuero cabelludo', 'Cuello y hombros', 'Zona lumbar', 'Pies y plantas'], pressure: ['Suave', 'Media', 'Firme'], submit: 'Enviar registro', submitted: 'Registro sincronizado con recepción', steps: ['Perfil', 'Preferencias', 'Consentimiento'] },
  }[currentLang];

  const togglePainPoint = (point: string) => {
    if (selectedPainPoints.includes(point)) {
      setSelectedPainPoints(selectedPainPoints.filter((p) => p !== point));
    } else {
      setSelectedPainPoints([...selectedPainPoints, point]);
    }
  };

  const handleSimulateChime = () => {
    setIsChimeActive(true);
    setTimeout(() => setIsChimeActive(false), 2000);
  };

  useEffect(() => {
    if (servicePhase !== 'active') return;
    const timer = window.setInterval(() => setServiceSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [servicePhase]);

  useEffect(() => {
    setSelectedStaffLang(currentLang === 'zh-CN' ? 'zh' : currentLang);
  }, [currentLang]);

  const timerDisplay = `${String(Math.floor(serviceSeconds / 60)).padStart(2, '0')}:${String(serviceSeconds % 60).padStart(2, '0')}`;
  const phaseLabel = staffLabels[servicePhase];

  return (
    <section id="staff-kiosk" className="py-20 bg-white border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#edf8f3] border border-[#b9d6cc] text-[#096b61] text-xs font-bold uppercase tracking-wider mb-3">
            <Smartphone className="w-3.5 h-3.5" />
            <span>{t.staffAndKiosk.badge}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {t.staffAndKiosk.title}
          </h2>
          <p className="mt-3.5 text-base text-slate-600 leading-relaxed">
            {t.staffAndKiosk.subtitle}
          </p>
        </div>

        {/* 2-Column Hardware & Software Interactive Displays */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left Column: Multilingual Staff PWA Card Simulation */}
          <div className="demo-window lg:col-span-6 flex flex-col justify-between bg-slate-50/60 p-6 sm:p-8">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl bg-[#d9f2e8] text-[#096b61] flex items-center justify-center">
                    <Smartphone className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg text-slate-900">
                      {t.staffAndKiosk.staffPwa.title}
                    </h3>
                    <p className="text-xs text-slate-500">{ui.staffPwaMeta}</p>
                  </div>
                </div>

                {/* Staff Language Toggle */}
                <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-200 text-xs shadow-2xs">
                  <button
                    onClick={() => setSelectedStaffLang('vi')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'vi' ? 'bg-[#096b61] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇻🇳 VI
                  </button>
                  <button
                    onClick={() => setSelectedStaffLang('zh')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'zh' ? 'bg-[#096b61] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇨🇳 中文
                  </button>
                  <button
                    onClick={() => setSelectedStaffLang('en')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'en' ? 'bg-[#096b61] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇺🇸 EN
                  </button>
                  <button
                    onClick={() => setSelectedStaffLang('es')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'es' ? 'bg-[#096b61] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇪🇸 ES
                  </button>
                  <button
                    onClick={() => setSelectedStaffLang('ko')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'ko' ? 'bg-[#096b61] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇰🇷 KO
                  </button>
                </div>
              </div>

              {/* Realistic Mobile Task Card Screen */}
              <div className="relative mx-auto mt-5 w-full max-w-[430px] rounded-[30px] border-[6px] border-[#1d292b] bg-slate-950 p-4 text-white shadow-[0_24px_48px_rgba(12,41,45,.22)]">
                <div className="absolute left-1/2 top-0 h-4 w-24 -translate-x-1/2 rounded-b-xl bg-[#1d292b]" />
                <div className="flex items-center justify-between pb-2.5 border-b border-slate-800 text-xs">
                  <div className="flex items-center gap-1.5 text-[#7de0c3]">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="font-bold">
                      {selectedStaffLang === 'vi' && 'Phiếu nhiệm vụ: Lily V.'}
                      {selectedStaffLang === 'zh' && '技师任务卡: Lily V.'}
                      {selectedStaffLang === 'en' && 'Assigned Task: Lily V.'}
                      {selectedStaffLang === 'es' && 'Tarjeta de Tarea: Lily V.'}
                      {selectedStaffLang === 'ko' && '배정 작업표: Lily V.'}
                    </span>
                  </div>
                  <button
                    onClick={handleSimulateChime}
                    className={`px-2 py-1 rounded-lg flex items-center gap-1 text-[10px] font-bold border transition-colors ${
                      isChimeActive
                        ? 'bg-amber-400 text-slate-950 border-amber-300 animate-bounce'
                        : 'bg-slate-800 text-slate-300 border-slate-700'
                    }`}
                  >
                    <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                    <span>{isChimeActive ? staffLabels.chiming : staffLabels.ring}</span>
                  </button>
                </div>

                <div className="py-3 space-y-2">
                  <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-3 py-2"><span className={`text-[10px] font-extrabold ${servicePhase === 'complete' ? 'text-emerald-400' : 'text-[#a6ead6]'}`}>{phaseLabel}</span><span className="font-mono text-sm font-bold text-white">{timerDisplay}</span></div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-extrabold text-white">David K. (Walk-in)</div>
                      <div className="text-xs text-[#a6ead6] font-medium">
                        {selectedStaffLang === 'vi' && 'Phòng 2 • 60p Massage Body + Đá nóng'}
                        {selectedStaffLang === 'zh' && '2号房 • 60分钟身体按摩 + 热石'}
                        {selectedStaffLang === 'en' && 'Room 2 • 60m Body Massage + Hot Stone'}
                        {selectedStaffLang === 'es' && 'Sala 2 • 60m Masaje Corporal + Piedras Calientes'}
                        {selectedStaffLang === 'ko' && '룸 2 • 60분 바디 마사지 + 핫스톤'}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-slate-400 font-mono">{staffLabels.turn}</div>
                      <div className="text-sm font-bold text-amber-400 font-mono">{staffLabels.round}</div>
                    </div>
                  </div>

                  {/* Customer Specific Notes in Staff Language */}
                  <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700 text-xs">
                    <div className="text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 text-amber-400" />
                      {selectedStaffLang === 'vi' && 'Lưu ý của khách:'}
                      {selectedStaffLang === 'zh' && '顾客专属偏好:'}
                      {selectedStaffLang === 'en' && 'Customer Intake Notes:'}
                      {selectedStaffLang === 'es' && 'Notas del Cliente:'}
                      {selectedStaffLang === 'ko' && '고객 주의사항:'}
                    </div>
                    <div className="text-slate-200 text-[11px] leading-relaxed">
                      {selectedStaffLang === 'vi' && 'Lực mạnh ở Cổ & Thắt lưng. Dị ứng tinh dầu Lavender.'}
                      {selectedStaffLang === 'zh' && '颈部和腰部要求重力。对薰衣草精油过敏。'}
                      {selectedStaffLang === 'en' && 'Deep pressure on Neck & Lower Back. Lavender allergy.'}
                      {selectedStaffLang === 'es' && 'Presión fuerte en Cuello y Zona Lumbar. Alergia a Lavanda.'}
                      {selectedStaffLang === 'ko' && '목과 허리 집중 강한 압. 라벤더 오일 알레르기 주의.'}
                    </div>
                  </div>

                  {/* Big Tactile Action Buttons (Glove & Wet-Hand Friendly) */}
                  <div className="pt-2 grid grid-cols-2 gap-2">
                    <button onClick={() => { if (servicePhase === 'assigned') setServicePhase('active'); else if (servicePhase === 'complete') { setServicePhase('assigned'); setServiceSeconds(48 * 60 + 15); } }} disabled={servicePhase === 'active'} className="py-3 px-2 rounded-xl bg-[#096b61] hover:bg-[#064b46] disabled:bg-slate-700 disabled:text-slate-400 text-white font-extrabold text-xs text-center shadow-md active:scale-95 transition-colors">
                      {servicePhase === 'complete' ? staffLabels.reset : staffLabels.start}
                    </button>
                    <button onClick={() => setServicePhase('complete')} disabled={servicePhase !== 'active'} className="py-3 px-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-45 text-slate-200 font-extrabold text-xs text-center border border-slate-700 active:scale-95 transition-colors">
                      {staffLabels.done}
                    </button>
                  </div>
                </div>
              </div>

              {/* Bullet Features */}
              <ul className="mt-5 space-y-2 text-xs sm:text-sm text-slate-600">
                {t.staffAndKiosk.staffPwa.features.map((ft, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>{ft}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Right Column: iPad Intake Kiosk & Body Pain Map Simulation */}
          <div className="demo-window lg:col-span-6 flex flex-col justify-between bg-slate-50/60 p-6 sm:p-8">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl bg-[#d9f2e8] text-[#096b61] flex items-center justify-center">
                    <Tablet className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg text-slate-900">
                      {t.staffAndKiosk.kiosk.title}
                    </h3>
                    <p className="text-xs text-slate-500">{ui.kioskMeta}</p>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-[#edf8f3] text-[#096b61] border border-[#b9d6cc]">
                  {kioskLabels.mode}
                </span>
              </div>

              {/* Interactive Body Pain Map Simulation */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 space-y-3 shadow-[0_16px_36px_rgba(20,52,54,.08)]">
                <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3">{kioskLabels.steps.map((step, index) => <div key={step} className="flex items-center gap-1.5"><span className={`grid h-5 w-5 place-items-center rounded-full text-[9px] font-extrabold ${index < 2 || kioskSubmitted ? 'bg-[#096b61] text-white' : 'bg-slate-100 text-slate-500'}`}>{index + 1}</span><span className="truncate text-[9px] font-bold text-slate-500">{step}</span></div>)}</div>
                <div className="flex items-center justify-between text-xs font-semibold text-slate-900">
                  <span>1. {ui.painPrompt}</span>
                  <span className="text-[11px] text-[#096b61] font-bold">
                    {selectedPainPoints.length} {ui.selectedAreas}
                  </span>
                </div>

                {/* Body Area Toggle Buttons */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
                  {[
                    { id: 'head', label: kioskLabels.parts[0] },
                    { id: 'neck', label: kioskLabels.parts[1] },
                    { id: 'lowerBack', label: kioskLabels.parts[2] },
                    { id: 'feet', label: kioskLabels.parts[3] },
                  ].map((part) => {
                    const isSelected = selectedPainPoints.includes(part.id);
                    return (
                      <button
                        key={part.id}
                        onClick={() => togglePainPoint(part.id)}
                        className={`p-2 rounded-xl border text-center transition-all ${
                          isSelected
                            ? 'bg-[#096b61] text-white border-[#096b61] font-bold shadow-xs'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {part.label}
                      </button>
                    );
                  })}
                </div>

                {/* Pressure Selector */}
                <div className="pt-2 border-t border-slate-100">
                  <div className="text-xs font-semibold text-slate-900 mb-1.5">
                    2. {ui.pressurePrompt}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 text-xs">
                    {(['Soft', 'Medium', 'Deep / Firm'] as const).map((lvl, index) => (
                      <button
                        key={lvl}
                        onClick={() => setSelectedPressure(lvl)}
                        className={`p-1.5 rounded-lg border text-center font-medium transition-colors ${
                          selectedPressure === lvl
                            ? 'bg-[#096b61] text-white border-[#096b61] font-bold'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {kioskLabels.pressure[index]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Digital Signature & Safety Checklist */}
                <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
                  <div className="flex items-center gap-1.5">
                    <FileSignature className="w-4 h-4 text-[#096b61]" />
                    <span>{ui.signedWaiver}</span>
                  </div>
                  <span className="text-emerald-700 font-bold">✓ {ui.encrypted}</span>
                </div>
                <button type="button" onClick={() => setKioskSubmitted(true)} className={`w-full rounded-xl px-4 py-3 text-xs font-extrabold transition ${kioskSubmitted ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'bg-[#096b61] text-white hover:bg-[#064b46]'}`}>{kioskSubmitted ? `✓ ${kioskLabels.submitted}` : kioskLabels.submit}</button>
              </div>

              {/* Bullet Features */}
              <ul className="mt-5 space-y-2 text-xs sm:text-sm text-slate-600">
                {t.staffAndKiosk.kiosk.features.map((ft, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>{ft}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Non-Medical Disclaimer Notice */}
            <div className="mt-4 pt-3 border-t border-slate-200/80 text-[11px] text-slate-500 leading-relaxed italic">
              {t.staffAndKiosk.kiosk.disclaimer}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
