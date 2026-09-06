import React, { useState } from 'react';
import { Clock, Check } from 'lucide-react';

interface InteractiveTimePickerProps {
  currentIso?: string;
  displayTime?: string;
  onSelectTime: (newIso: string) => void;
  disabled?: boolean;
}

export const InteractiveTimePicker: React.FC<InteractiveTimePickerProps> = ({
  currentIso,
  displayTime,
  onSelectTime,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // 根据当前 ISO 时间推算基础日期与时间选项
  const baseDate = currentIso ? new Date(currentIso) : new Date();

  // 生成围绕当前时段的常用 15 分钟间隔选项
  const options = React.useMemo(() => {
    const list: Array<{ label: string; iso: string }> = [];
    const year = baseDate.getFullYear();
    const month = baseDate.getMonth();
    const date = baseDate.getDate();

    // 08:00 到 20:00 每 15 分钟
    for (let h = 8; h <= 20; h++) {
      for (const m of [0, 15, 30, 45]) {
        if (h === 20 && m > 0) break;
        const d = new Date(year, month, date, h, m, 0, 0);
        const label = d.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        list.push({ label, iso: d.toISOString() });
      }
    }
    return list;
  }, [baseDate]);

  const handleSelect = (iso: string) => {
    onSelectTime(iso);
    setIsOpen(false);
  };

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/80 hover:bg-emerald-100 hover:border-emerald-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-2xs"
      >
        <Clock className="w-3.5 h-3.5 text-emerald-600" />
        <span>{displayTime || '选择时间'}</span>
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute left-0 mt-1.5 w-48 max-h-56 overflow-y-auto rounded-xl bg-white p-1.5 shadow-xl ring-1 ring-black/10 z-50 divide-y divide-zinc-100 animate-in fade-in zoom-in-95 duration-100">
            <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">
              选择起始时间
            </div>
            <div className="py-1">
              {options.map((opt) => {
                const isSelected = displayTime === opt.label;
                return (
                  <button
                    key={opt.iso}
                    type="button"
                    onClick={() => handleSelect(opt.iso)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs rounded-lg transition-colors cursor-pointer text-left ${
                      isSelected
                        ? 'bg-emerald-500 text-white font-medium'
                        : 'text-zinc-700 hover:bg-zinc-100'
                    }`}
                  >
                    <span>{opt.label}</span>
                    {isSelected && <Check className="w-3.5 h-3.5" />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
