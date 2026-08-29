import React from 'react';
import { Delete, X } from 'lucide-react';

interface VirtualKeypadProps {
  onKeyPress: (char: string) => void;
  onDelete: () => void;
  onClear: () => void;
  mode?: 'numeric' | 'alphanumeric';
  className?: string;
}

export const VirtualKeypad: React.FC<VirtualKeypadProps> = ({
  onKeyPress,
  onDelete,
  onClear,
  mode = 'numeric',
  className = '',
}) => {
  if (mode === 'alphanumeric') {
    const row1Numbers = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
    const row2Letters = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'];
    const row3Letters = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'];
    const row4Letters = ['Z', 'X', 'C', 'V', 'B', 'N', 'M'];

    return (
      <div className={`w-full max-w-xl mx-auto space-y-2 select-none ${className}`}>
        {/* 数字排 1 - 0 */}
        <div className="grid grid-cols-10 gap-1.5 sm:gap-2">
          {row1Numbers.map((char) => (
            <button
              key={char}
              type="button"
              onClick={() => onKeyPress(char)}
              className="kiosk-touch-target h-12 sm:h-14 rounded-xl bg-slate-100 hover:bg-teal-50 active:bg-teal-600 active:text-white text-slate-800 font-extrabold text-lg sm:text-xl flex items-center justify-center transition-all active:scale-95 border border-slate-200 shadow-2xs"
            >
              {char}
            </button>
          ))}
        </div>

        {/* 字母排 Q - P */}
        <div className="grid grid-cols-10 gap-1.5 sm:gap-2">
          {row2Letters.map((char) => (
            <button
              key={char}
              type="button"
              onClick={() => onKeyPress(char)}
              className="kiosk-touch-target h-12 sm:h-14 rounded-xl bg-white hover:bg-teal-50 active:bg-teal-600 active:text-white text-slate-900 font-extrabold text-base sm:text-lg flex items-center justify-center transition-all active:scale-95 border border-slate-200 shadow-2xs"
            >
              {char}
            </button>
          ))}
        </div>

        {/* 字母排 A - L */}
        <div className="flex justify-center gap-1.5 sm:gap-2 px-3">
          {row3Letters.map((char) => (
            <button
              key={char}
              type="button"
              onClick={() => onKeyPress(char)}
              className="kiosk-touch-target flex-1 h-12 sm:h-14 rounded-xl bg-white hover:bg-teal-50 active:bg-teal-600 active:text-white text-slate-900 font-extrabold text-base sm:text-lg flex items-center justify-center transition-all active:scale-95 border border-slate-200 shadow-2xs"
            >
              {char}
            </button>
          ))}
        </div>

        {/* 字母排 Z - M + 清空与退格 */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* 清空按钮 */}
          <button
            type="button"
            onClick={onClear}
            className="kiosk-touch-target px-3 sm:px-4 h-12 sm:h-14 rounded-xl bg-slate-200/80 hover:bg-slate-300 active:bg-slate-400 text-slate-600 font-bold text-xs flex items-center justify-center gap-1 transition-all active:scale-95 border border-slate-300/80"
          >
            <X className="w-4 h-4" />
            <span className="hidden sm:inline">清空</span>
          </button>

          {row4Letters.map((char) => (
            <button
              key={char}
              type="button"
              onClick={() => onKeyPress(char)}
              className="kiosk-touch-target flex-1 h-12 sm:h-14 rounded-xl bg-white hover:bg-teal-50 active:bg-teal-600 active:text-white text-slate-900 font-extrabold text-base sm:text-lg flex items-center justify-center transition-all active:scale-95 border border-slate-200 shadow-2xs"
            >
              {char}
            </button>
          ))}

          {/* 退格删除按钮 */}
          <button
            type="button"
            onClick={onDelete}
            className="kiosk-touch-target px-3 sm:px-4 h-12 sm:h-14 rounded-xl bg-slate-200/80 hover:bg-slate-300 active:bg-slate-400 text-slate-700 font-bold text-xs flex items-center justify-center gap-1 transition-all active:scale-95 border border-slate-300/80"
          >
            <Delete className="w-4 h-4" />
            <span className="hidden sm:inline">删除</span>
          </button>
        </div>
      </div>
    );
  }

  // 纯数字键盘（用于输入手机号等纯数字场景）
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
