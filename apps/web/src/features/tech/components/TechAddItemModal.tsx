import { useState } from 'react';
import { Plus, X, Clock, Check } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { Button } from '@/components/ui/Button';
import { pickText } from '@gf/contracts';
import { getMockStore, mockAddAddon } from '../lib/mockData';

interface TechAddItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  ticketId: string;
  onAddSuccess?: () => void;
}

export function TechAddItemModal({ isOpen, onClose, onAddSuccess }: TechAddItemModalProps) {
  const { t, language } = useLanguage();
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  const mockStore = getMockStore();
  const services = mockStore.addonCatalog;

  if (!isOpen) return null;

  const handleConfirmAdd = () => {
    if (selectedServiceId) {
      mockAddAddon(selectedServiceId);
      if (onAddSuccess) onAddSuccess();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4">
      <div
        className="w-full max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in slide-in-from-bottom duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center font-bold">
              <Plus className="w-5 h-5" />
            </div>
            <h3 className="text-base font-bold text-slate-900">{t('addServiceItem')}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 项目列表 */}
        <div className="p-4 overflow-y-auto space-y-2.5 flex-1">
          {services.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-400">{t('noAddonServices')}</div>
          ) : (
            services.map((svc) => {
              const isSelected = selectedServiceId === svc.id;
              return (
                <button
                  key={svc.id}
                  type="button"
                  onClick={() => setSelectedServiceId(svc.id)}
                  className={`w-full p-3.5 rounded-2xl border text-left flex items-center justify-between transition-all active:scale-98 ${
                    isSelected
                      ? 'border-teal-500 bg-teal-50/60 shadow-xs ring-1 ring-teal-500'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-900 text-sm">
                      {pickText(svc.name, language)}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500 mt-1">
                      {svc.durationMin > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-slate-400" />
                          {svc.durationMin} {t('mins')}
                        </span>
                      )}
                      <span className="font-bold text-emerald-600 font-mono">
                        +${(svc.priceCents / 100).toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div
                    className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ml-2 transition-colors ${
                      isSelected
                        ? 'border-teal-600 bg-teal-600 text-white'
                        : 'border-slate-300 bg-slate-50'
                    }`}
                  >
                    {isSelected && <Check className="w-3.5 h-3.5" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* 底部确认按钮 */}
        <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center gap-3">
          <Button variant="ghost" className="flex-1 rounded-2xl" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            className="flex-1 bg-teal-600 hover:bg-teal-700 text-white shadow-md rounded-2xl font-bold"
            disabled={!selectedServiceId}
            onClick={handleConfirmAdd}
          >
            {t('confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
