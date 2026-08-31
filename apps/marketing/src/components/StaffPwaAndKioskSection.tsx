import React, { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
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
  const { t } = useLanguage();
  const [selectedStaffLang, setSelectedStaffLang] = useState<'vi' | 'zh' | 'en' | 'es' | 'ko'>('vi');
  const [isChimeActive, setIsChimeActive] = useState(false);
  const [serviceTimer, setServiceTimer] = useState('48:15');

  // Interactive Pain Map Body Points
  const [selectedPainPoints, setSelectedPainPoints] = useState<string[]>(['neck', 'lowerBack']);
  const [selectedPressure, setSelectedPressure] = useState<'Soft' | 'Medium' | 'Deep / Firm'>('Deep / Firm');

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

  return (
    <section id="staff-kiosk" className="py-20 bg-white border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold uppercase tracking-wider mb-3">
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
          <div className="lg:col-span-6 rounded-3xl bg-slate-50/60 border border-slate-200 p-6 sm:p-8 flex flex-col justify-between shadow-xs">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
                    <Smartphone className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg text-slate-900">
                      {t.staffAndKiosk.staffPwa.title}
                    </h3>
                    <p className="text-xs text-slate-500">No App Store downloads • Instant Web PWA</p>
                  </div>
                </div>

                {/* Staff Language Toggle */}
                <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-200 text-xs shadow-2xs">
                  <button
                    onClick={() => setSelectedStaffLang('vi')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'vi' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇻🇳 VI
                  </button>
                  <button
                    onClick={() => setSelectedStaffLang('zh')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'zh' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇨🇳 中文
                  </button>
                  <button
                    onClick={() => setSelectedStaffLang('en')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'en' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇺🇸 EN
                  </button>
                  <button
                    onClick={() => setSelectedStaffLang('es')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'es' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇪🇸 ES
                  </button>
                  <button
                    onClick={() => setSelectedStaffLang('ko')}
                    className={`px-2 py-1 rounded-lg font-bold transition-colors ${
                      selectedStaffLang === 'ko' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🇰🇷 KO
                  </button>
                </div>
              </div>

              {/* Realistic Mobile Task Card Screen */}
              <div className="mt-4 p-4 rounded-2xl bg-slate-900 border border-slate-800 text-white shadow-md">
                <div className="flex items-center justify-between pb-2.5 border-b border-slate-800 text-xs">
                  <div className="flex items-center gap-1.5 text-blue-400">
                    <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
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
                    <span>{isChimeActive ? 'Chiming 🔔' : 'Test Ring'}</span>
                  </button>
                </div>

                <div className="py-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-extrabold text-white">David K. (Walk-in)</div>
                      <div className="text-xs text-blue-300 font-medium">
                        {selectedStaffLang === 'vi' && 'Phòng 2 • 60p Massage Body + Đá nóng'}
                        {selectedStaffLang === 'zh' && '2号房 • 60分钟身体按摩 + 热石'}
                        {selectedStaffLang === 'en' && 'Room 2 • 60m Body Massage + Hot Stone'}
                        {selectedStaffLang === 'es' && 'Sala 2 • 60m Masaje Corporal + Piedras Calientes'}
                        {selectedStaffLang === 'ko' && '룸 2 • 60분 바디 마사지 + 핫스톤'}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-slate-400 font-mono">Turn Count</div>
                      <div className="text-sm font-bold text-amber-400 font-mono">1.0 Round</div>
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
                    <button className="py-3 px-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs text-center shadow-md active:scale-95 transition-colors">
                      {selectedStaffLang === 'vi' && 'Bắt đầu làm (Start)'}
                      {selectedStaffLang === 'zh' && '开始服务 (Start)'}
                      {selectedStaffLang === 'en' && 'Start Session'}
                      {selectedStaffLang === 'es' && 'Iniciar Sesión'}
                      {selectedStaffLang === 'ko' && '서비스 시작 (Start)'}
                    </button>
                    <button className="py-3 px-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-extrabold text-xs text-center border border-slate-700 active:scale-95 transition-colors">
                      {selectedStaffLang === 'vi' && 'Hoàn thành (Finish)'}
                      {selectedStaffLang === 'zh' && '服务完成 (Done)'}
                      {selectedStaffLang === 'en' && 'Complete'}
                      {selectedStaffLang === 'es' && 'Completado'}
                      {selectedStaffLang === 'ko' && '완료 (Done)'}
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
          <div className="lg:col-span-6 rounded-3xl bg-slate-50/60 border border-slate-200 p-6 sm:p-8 flex flex-col justify-between shadow-xs">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
                    <Tablet className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg text-slate-900">
                      {t.staffAndKiosk.kiosk.title}
                    </h3>
                    <p className="text-xs text-slate-500">Walk-in Intake • Pain Map • Digital Consent</p>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                  iPad Kiosk Mode
                </span>
              </div>

              {/* Interactive Body Pain Map Simulation */}
              <div className="p-4 rounded-2xl bg-white border border-slate-200 space-y-3 shadow-2xs">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-900">
                  <span>1. Tap Areas of Discomfort or Pain Focus:</span>
                  <span className="text-[11px] text-blue-600 font-bold">
                    {selectedPainPoints.length} Area(s) Selected
                  </span>
                </div>

                {/* Body Area Toggle Buttons */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
                  {[
                    { id: 'head', label: 'Head & Scalp (头部)' },
                    { id: 'neck', label: 'Neck & Traps (颈肩)' },
                    { id: 'lowerBack', label: 'Lower Back (腰部)' },
                    { id: 'feet', label: 'Feet / Soles (足底)' },
                  ].map((part) => {
                    const isSelected = selectedPainPoints.includes(part.id);
                    return (
                      <button
                        key={part.id}
                        onClick={() => togglePainPoint(part.id)}
                        className={`p-2 rounded-xl border text-center transition-all ${
                          isSelected
                            ? 'bg-blue-600 text-white border-blue-600 font-bold shadow-xs'
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
                    2. Desired Pressure Level:
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 text-xs">
                    {(['Soft', 'Medium', 'Deep / Firm'] as const).map((lvl) => (
                      <button
                        key={lvl}
                        onClick={() => setSelectedPressure(lvl)}
                        className={`p-1.5 rounded-lg border text-center font-medium transition-colors ${
                          selectedPressure === lvl
                            ? 'bg-blue-600 text-white border-blue-600 font-bold'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Digital Signature & Safety Checklist */}
                <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
                  <div className="flex items-center gap-1.5">
                    <FileSignature className="w-4 h-4 text-blue-600" />
                    <span>Digital Waiver Signed</span>
                  </div>
                  <span className="text-emerald-700 font-bold">✓ AES-256 Encrypted</span>
                </div>
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
