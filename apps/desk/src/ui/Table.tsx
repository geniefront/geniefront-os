/**
 * 表格。报表、日结、排班这三处的数字表用它。
 *
 * ## 两条不能省的
 *
 * **① 横向滚动必须发生在表格自己身上，不能让整页横滚。**
 * 前台那台电脑常常是 1280 宽，而报表有八列。整页横滚的话，
 * 侧边栏会跟着滑走 —— 她以为界面坏了。
 *
 * **② 数字列右对齐 + 等宽数字。** 金额是要逐列扫下来对比的，
 * 左对齐的话「$1,240.00」和「$98.00」的小数点错位，一眼看去
 * 后者反而更长。这一条在钱的表格里不是审美问题。
 *
 * ⚠️ 第一列默认左对齐（那是名字），其余默认右对齐（那是数）。
 * 要覆盖就传 `align`。
 */

import type { ReactNode } from 'react';
import { Card } from './Card';
import { cn } from './cn';

export interface Column {
  key: string;
  header: ReactNode;
  align?: 'left' | 'right';
}

export function Table({ title, columns, children, extra }: {
  title?: ReactNode;
  columns: Column[];
  /** `<Row>` 的列表 */
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      {title && (
        <div className="flex items-center gap-3 px-5 pb-1 pt-4">
          <h3 className="text-base font-semibold tracking-[-0.01em]">{title}</h3>
          {extra && <div className="ml-auto text-xs text-ink-3">{extra}</div>}
        </div>
      )}
      {/* ⚠️ 滚动条在这一层 —— 整页永远不横滚 */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={c.key}
                    className={cn(
                      'whitespace-nowrap border-b-2 border-line px-3.5 py-2 text-2xs',
                      'font-bold uppercase tracking-[0.07em] text-ink-3',
                      (c.align ?? (i === 0 ? 'left' : 'right')) === 'left' ? 'text-left' : 'text-right',
                    )}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </Card>
  );
}

/** 一行。`cells` 的顺序要和 `columns` 一致 */
export function Row({ cells, columns, muted, className }: {
  cells: ReactNode[];
  columns: Column[];
  /** 「这一天没有记录」这类：整行压灰，和「这一天是 0」区分开 */
  muted?: boolean;
  className?: string;
}) {
  return (
    <tr className={cn(muted && 'bg-sunken', className)}>
      {cells.map((c, i) => {
        const align = columns[i]?.align ?? (i === 0 ? 'left' : 'right');
        return (
          <td key={i}
              className={cn(
                'border-b border-line px-3.5 py-2 text-xs',
                align === 'left' ? 'text-left' : 'tnum text-right',
                muted && 'text-ink-3',
              )}>
            {c}
          </td>
        );
      })}
    </tr>
  );
}
