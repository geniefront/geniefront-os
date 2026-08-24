/**
 * 说明图标。
 *
 * 界面上的解释性文字分两类：
 *   · **动作要用到的** —— 留在正文（「技师位已满，上限 1 人」）
 *   · **只在人疑惑时才需要的** —— 收进这个图标（为什么会满、满了怎么办）
 *
 * 原来两类混在一起铺在屏上，正文被解释淹没。收起来之后，
 * 屏上只剩状态和数字，需要时点一下再看。
 *
 * 触屏与鼠标双轨：iPad 上没有 hover，所以用点击开合而不是 title 属性。
 */

import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

export function InfoDot({ text, label = '说明' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <span ref={ref} className="infodot">
      <button
        type="button"
        className="infodot-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <Info size={15} />
      </button>
      {open && <span className="infodot-pop" role="tooltip">{text}</span>}
    </span>
  );
}
