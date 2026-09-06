/**
 * 助手回答的轻量 Markdown 渲染。
 *
 * 只认副驾提示词里明确要求它产出的那几种结构：标题、项目符号、表格、
 * `**粗体**`、`[标签]`、以及 💡/⚠️ 开头的提示块。**刻意不引入完整
 * Markdown 库** —— 渲染面越大，模型输出里的意外字符能造成的版面破坏越多，
 * 而前台那一屏经不起错乱。
 */

import React from 'react';
import { useLanguage } from '@/LanguageContext';

function FormattedInlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={i} className="font-bold text-slate-950 bg-teal-50/80 text-teal-950 px-1 py-0.5 rounded">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith('[') && part.endsWith(']')) {
          return (
            <span
              key={i}
              className="inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200"
            >
              {part.slice(1, -1)}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function TableBlock({ rows }: { rows: string[] }) {
  if (rows.length < 2) return null;
  const headerCols = rows[0]
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  const bodyRows = rows
    .slice(1)
    .filter((r) => !r.includes('---'))
    .map((r) =>
      r
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );

  return (
    <div className="my-2.5 overflow-x-auto rounded-xl border border-slate-200 shadow-2xs">
      <table className="w-full text-left text-[11px] border-collapse bg-white">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {headerCols.map((col, i) => (
              <th key={i} className="px-2.5 py-1.5 font-bold text-slate-700 whitespace-nowrap">
                <FormattedInlineText text={col} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {bodyRows.map((row, rIdx) => (
            <tr key={rIdx} className={rIdx % 2 === 1 ? 'bg-slate-50/50' : 'bg-white'}>
              {row.map((cell, cIdx) => (
                <td key={cIdx} className="px-2.5 py-1.5 text-slate-700 whitespace-nowrap">
                  <FormattedInlineText text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BeautifiedMessageContent({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const { t } = useLanguage();
  if (!content) {
    if (isStreaming) {
      return (
        <div className="flex items-center gap-2 text-slate-400 text-xs italic py-1">
          <span className="animate-pulse">{t('schedule.copilotGenerating')}</span>
        </div>
      );
    }
    return null;
  }

  const lines = content.split('\n');
  const blocks: Array<{ type: 'heading' | 'bullet' | 'callout' | 'table' | 'text'; content: string | string[] }> = [];

  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length > 0) {
      blocks.push({ type: 'table', content: [...tableBuffer] });
      tableBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableBuffer.push(trimmed);
      continue;
    } else {
      flushTable();
    }

    if (!trimmed) {
      blocks.push({ type: 'text', content: '' });
      continue;
    }

    if (trimmed.startsWith('### ') || trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      blocks.push({ type: 'heading', content: trimmed.replace(/^#+\s*/, '') });
    } else if (trimmed.startsWith('• ') || trimmed.startsWith('- ') || /^\d+\.\s/.test(trimmed)) {
      blocks.push({ type: 'bullet', content: trimmed.replace(/^[•\-\d.]+\s*/, '') });
    } else if (trimmed.startsWith('💡') || trimmed.startsWith('⚠️')) {
      blocks.push({ type: 'callout', content: trimmed });
    } else {
      blocks.push({ type: 'text', content: line });
    }
  }
  flushTable();

  return (
    <div className="space-y-1.5 text-xs leading-relaxed text-slate-800">
      {blocks.map((block, idx) => {
        if (block.type === 'table') {
          return <TableBlock key={idx} rows={block.content as string[]} />;
        }
        if (block.type === 'heading') {
          return (
            <div
              key={idx}
              className="pt-2 pb-1 font-bold text-xs text-teal-900 border-b border-teal-100 flex items-center gap-1.5 tracking-tight"
            >
              <span>{block.content as string}</span>
            </div>
          );
        }
        if (block.type === 'bullet') {
          return (
            <div key={idx} className="flex items-start gap-2 pl-0.5 py-0.5">
              <span className="text-teal-600 font-bold mt-0.5 text-xs shrink-0">•</span>
              <div className="flex-1 leading-relaxed">
                <FormattedInlineText text={block.content as string} />
              </div>
            </div>
          );
        }
        if (block.type === 'callout') {
          const text = block.content as string;
          const isWarn = text.startsWith('⚠️');
          return (
            <div
              key={idx}
              className={`my-2 rounded-xl p-2.5 border text-xs leading-normal font-medium ${
                isWarn
                  ? 'bg-amber-50/80 border-amber-200 text-amber-950'
                  : 'bg-teal-50/80 border-teal-200 text-teal-950'
              }`}
            >
              <FormattedInlineText text={text} />
            </div>
          );
        }
        if (!block.content) {
          return <div key={idx} className="h-0.5" />;
        }
        return (
          <p key={idx} className="py-0.5">
            <FormattedInlineText text={block.content as string} />
          </p>
        );
      })}
    </div>
  );
}
