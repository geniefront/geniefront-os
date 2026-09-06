/**
 * 模型请求前台澄清时的候选卡片。
 *
 * 这一块此前**完全没有界面**：后端的 `ask_user_clarification` 元工具会返回
 * `candidateOptions`（两位同名 Lisa 的电话尾号和上次到店时间），但前端只把
 * `question` 当普通文本渲染，候选项被整个丢掉，前台只能自己把「尾号 1234」
 * 手打回输入框。
 *
 * 点一下候选就把它的 label 作为下一轮提问发出去 —— 发 label 不发 value，
 * 因为下一轮模型拿到的是同一份候选列表，它自己会把 label 对回 customerId；
 * 而把裸 UUID 塞进对话历史既难读，又给了一个「用户说了什么 ID」的错觉。
 */

import React from 'react';
import { HelpCircle } from 'lucide-react';
import type { CopilotClarification } from '../api';

interface ClarificationCardProps {
  clarification: CopilotClarification;
  disabled?: boolean;
  onPick: (label: string) => void;
}

export const ClarificationCard: React.FC<ClarificationCardProps> = ({
  clarification,
  disabled = false,
  onPick,
}) => {
  const options = clarification.candidateOptions ?? [];
  if (options.length === 0) return null;

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3 my-2">
      <div className="flex items-start gap-2 mb-2.5">
        <HelpCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs font-semibold text-amber-950 leading-relaxed">
          {clarification.question}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onPick(opt.label)}
            className="text-left rounded-xl border border-amber-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-amber-950 shadow-2xs transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="block font-semibold">{opt.label}</span>
            {opt.description && (
              <span className="block text-[10px] font-normal text-amber-700">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};
