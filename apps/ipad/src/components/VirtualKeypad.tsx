import React from 'react';
import { Delete, X } from 'lucide-react';

interface VirtualKeypadProps {
  onKeyPress: (char: string) => void;
  onDelete: () => void;
  onClear: () => void;
  className?: string;
}

export const VirtualKeypad: React.FC<VirtualKeypadProps> = ({
  onKeyPress,
  onDelete,
  onClear,
  className = '',
}) => {
  const numericKeys = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['CLEAR', '0', 'DEL'],
  ];

  return (
    <div className={`grid grid-cols-3 gap-3 w-full max-w-sm mx-auto select-none ${className}`}>
      {numericKeys.map((row, rIdx) =>
        row.map((key, kIdx) => {
          if (key === 'CLEAR') {
            return (
              <button
                key={`key-${rIdx}-${kIdx}`}
                type="button"
                onClick={onClear}
                className="kiosk-touch-target h-16 rounded-2xl bg-slate-100/90 hover:bg-slate-200 active:bg-slate-300 text-slate-500 font-bold text-sm flex items-center justify-center transition-transform active:scale-95 border border-slate-200 shadow-2xs"
              >
                <X className="w-6 h-6 text-slate-500" />
              </button>
            );
          }
          if (key === 'DEL') {
            return (
              <button
                key={`key-${rIdx}-${kIdx}`}
                type="button"
                onClick={onDelete}
                className="kiosk-touch-target h-16 rounded-2xl bg-slate-100/90 hover:bg-slate-200 active:bg-slate-300 text-slate-700 font-bold text-sm flex items-center justify-center transition-transform active:scale-95 border border-slate-200 shadow-2xs"
              >
                <Delete className="w-6 h-6 text-slate-700" />
              </button>
            );
          }

          return (
            <button
              key={`key-${rIdx}-${kIdx}`}
              type="button"
              onClick={() => onKeyPress(key)}
              className="kiosk-touch-target h-16 rounded-2xl bg-white hover:bg-teal-50/50 active:bg-teal-600 active:text-white text-slate-900 font-extrabold text-2xl flex items-center justify-center transition-all active:scale-95 border border-slate-200 shadow-xs active:border-teal-600"
            >
              {key}
            </button>
          );
        }),
      )}
    </div>
  );
};
