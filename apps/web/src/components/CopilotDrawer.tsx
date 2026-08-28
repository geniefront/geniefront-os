import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useLanguage } from '@/LanguageContext';
import {
  X,
  Sparkles,
  Send,
  User,
  CheckCircle2,
  Play,
  Image as ImageIcon,
  Trash2,
  Calendar,
  Clock,
  BedDouble,
  ShieldAlert,
  ArrowRight,
  Check,
  Plus,
  History,
  MessageSquare,
  ChevronRight,
} from 'lucide-react';
import { Button } from './ui/Button';
import { Spinner, toast } from '@heroui/react';
import {
  streamAskCopilot,
  type CopilotHistoryItem,
  type CopilotProposal,
} from '@/features/copilot/api';
import { runCommand } from '@/lib/api';
import { useStoreTime } from '@/lib/time';
import { useSession } from '@/lib/session';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

interface CopilotDrawerProps {
  onClose: () => void;
}

export interface MessageItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  imagePreview?: string;
  proposal?: CopilotProposal | null;
  executed?: boolean;
  steps?: string[];
  isStreaming?: boolean;
}

function ThinkingAccordion({ steps, isStreaming }: { steps?: string[]; isStreaming?: boolean }) {
  const { t } = useLanguage();
  const [isOpen, setIsOpen] = useState(isStreaming ?? false);

  useEffect(() => {
    if (isStreaming) {
      setIsOpen(true);
    }
  }, [isStreaming]);

  if (!steps || steps.length === 0) {
    if (!isStreaming) return null;
  }

  const latestStep = steps && steps.length > 0 ? steps[steps.length - 1] : '正在分析...';

  return (
    <div className="mb-2.5 overflow-hidden rounded-xl border border-teal-500/30 bg-gradient-to-r from-teal-500/10 via-emerald-500/5 to-transparent text-xs transition-all shadow-2xs">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-3 py-2 text-left font-medium text-teal-800 hover:bg-teal-500/10 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 overflow-hidden">
          {isStreaming ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-600"></span>
            </span>
          ) : (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-teal-600 text-[10px] text-white font-bold">
              ✓
            </span>
          )}
          <span className="truncate text-[11px] font-semibold text-slate-700">
            {isStreaming ? (
              <span className="text-teal-700 font-bold">{latestStep}</span>
            ) : (
              <span>{t('schedule.copilotThinkingPrefix')}{steps?.length || 0}  {t('schedule.copilotThinkingSuffix')}</span>
            )}
          </span>
        </div>
        <ChevronRight
          className={`h-3.5 w-3.5 text-teal-600 shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-90' : ''
          }`}
        />
      </button>

      {isOpen && steps && steps.length > 0 && (
        <div className="border-t border-teal-500/20 px-3 py-2 space-y-1.5 bg-white/60">
          {steps.map((st, idx) => (
            <div key={idx} className="flex items-center gap-2 text-[11px] text-slate-600 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-500 shrink-0" />
              <span className="truncate">{st}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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

function BeautifiedMessageContent({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
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

export interface CopilotSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  userQueryCount: number; // 0..10
  messages: MessageItem[];
}

interface SelectedImageState {
  base64: string;
  previewUrl: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  name: string;
}

const MAX_SESSION_TURNS = 10;

const DEFAULT_WELCOME_MESSAGE: MessageItem = {
  id: 'welcome_msg',
  role: 'assistant',
  content:
    '您好！我是前台 AI 副驾。我可以帮您快速分析今日营收与客单价、查询预约空档、设置房间清洁、检索老客档案，或上传外部预约截图自动导入。所有修改操作均需您人工点击确认。',
  timestamp: Date.now(),
};

function createInitialSession(initialTitle = '新对话'): CopilotSession {
  return {
    id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: initialTitle,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userQueryCount: 0,
    messages: [{ ...DEFAULT_WELCOME_MESSAGE, timestamp: Date.now() }],
  };
}

export function CopilotDrawer({ onClose }: CopilotDrawerProps) {
  const storeTime = useStoreTime();
  const { t } = useLanguage();
  const { membership, membershipId } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const storageKey = useMemo(
    () => `gf_copilot_sessions_${membership?.locationId || membershipId || 'default'}`,
    [membership?.locationId, membershipId],
  );

  const [sessions, setSessions] = useState<CopilotSession[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return [createInitialSession()];
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return sessions[0]?.id || '';
  });

  const [showHistory, setShowHistory] = useState(false);
  const [inputText, setInputText] = useState('');
  const [selectedImage, setSelectedImage] = useState<SelectedImageState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [executingIdx, setExecutingIdx] = useState<number | null>(null);

  const activeSession = useMemo(() => {
    return sessions.find((s) => s.id === activeSessionId) || sessions[0] || createInitialSession();
  }, [sessions, activeSessionId]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(sessions));
    } catch {
      // ignore
    }
  }, [sessions, storageKey]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeSession.messages, isStreaming]);

  const handleNewSession = (title = '新对话') => {
    const newSess = createInitialSession(title);
    setSessions((prev) => [newSess, ...prev]);
    setActiveSessionId(newSess.id);
    setShowHistory(false);
    setInputText('');
    setSelectedImage(null);
    toast.success(t('schedule.copilotSessionNew'));
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setShowHistory(false);
    setInputText('');
    setSelectedImage(null);
  };

  const handleDeleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        const fresh = createInitialSession();
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (activeSessionId === id) {
        setActiveSessionId(filtered[0]!.id);
      }
      return filtered;
    });
    toast.success(t('schedule.copilotSessionDeleted'));
  };

  const processImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.danger(t('schedule.copilotBadImage'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.danger(t('schedule.copilotImageTooLarge'));
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      if (!dataUrl) return;
      const base64 = dataUrl.split(',')[1] || '';
      let mediaType: SelectedImageState['mediaType'] = 'image/png';
      if (file.type === 'image/jpeg') mediaType = 'image/jpeg';
      else if (file.type === 'image/webp') mediaType = 'image/webp';
      else if (file.type === 'image/gif') mediaType = 'image/gif';

      setSelectedImage({
        base64,
        previewUrl: dataUrl,
        mediaType,
        name: file.name,
      });
      toast.success(t('schedule.copilotImageLoaded'));
    };
    reader.readAsDataURL(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processImageFile(file);
    e.target.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          processImageFile(file);
          e.preventDefault();
          break;
        }
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processImageFile(file);
  };

  const handleSendMessage = async (textToSend?: string) => {
    const query = (textToSend || inputText).trim();
    if ((!query && !selectedImage) || isStreaming) return;

    let targetSession = activeSession;
    if (targetSession.userQueryCount >= MAX_SESSION_TURNS) {
      const newSess = createInitialSession(query ? query.slice(0, 16) : '预约导入');
      setSessions((prev) => [newSess, ...prev]);
      setActiveSessionId(newSess.id);
      targetSession = newSess;
      toast.info(t('schedule.copilotSessionFull'));
    }

    const nextCount = targetSession.userQueryCount + 1;
    let newTitle = targetSession.title;
    if (targetSession.title === '新对话' && query) {
      newTitle = query.slice(0, 16);
    }

    const userMsg: MessageItem = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      content: query || '【已发送预约截图】',
      timestamp: Date.now(),
      imagePreview: selectedImage?.previewUrl,
    };

    const assistantMsgId = `msg_${Date.now()}_a`;
    const placeholderAssistantMsg: MessageItem = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      steps: ['⚡ 正在连接智能引擎...'],
      isStreaming: true,
      timestamp: Date.now(),
    };

    const updatedMessages = [...targetSession.messages, userMsg];
    const imagePayload = selectedImage
      ? { base64: selectedImage.base64, mediaType: selectedImage.mediaType }
      : undefined;

    setSessions((prev) =>
      prev.map((s) =>
        s.id === targetSession.id
          ? {
              ...s,
              title: newTitle,
              updatedAt: Date.now(),
              userQueryCount: nextCount,
              messages: [...updatedMessages, placeholderAssistantMsg],
            }
          : s,
      ),
    );

    setInputText('');
    setSelectedImage(null);
    setIsStreaming(true);

    const history: CopilotHistoryItem[] = updatedMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-4)
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content }));

    try {
      await streamAskCopilot(
        {
          question: query || '请识别截图中的预约信息',
          sessionId: targetSession.id,
          image: imagePayload,
          history,
        },
        {
          onStep: (step: string) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== targetSession.id) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== assistantMsgId) return m;
                    const existing = m.steps ?? [];
                    if (existing.includes(step)) return m;
                    return { ...m, steps: [...existing, step] };
                  }),
                };
              }),
            );
          },
          onDelta: (delta: string) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== targetSession.id) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== assistantMsgId) return m;
                    return { ...m, content: (m.content || '') + delta, isStreaming: true };
                  }),
                };
              }),
            );
          },
          onProposal: (proposal: CopilotProposal) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== targetSession.id) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== assistantMsgId) return m;
                    return { ...m, proposal };
                  }),
                };
              }),
            );
          },
          onDone: (res: any) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== targetSession.id) return s;
                const msgs = s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    content: m.content || res.answer,
                    proposal: res.proposal ?? m.proposal,
                    isStreaming: false,
                  };
                });
                if (nextCount >= MAX_SESSION_TURNS) {
                  msgs.push({
                    id: `msg_${Date.now()}_sys`,
                    role: 'system',
                    content: `💡 当前会话已达 ${MAX_SESSION_TURNS} 次提问上限。下次提问将自动开启新会话。`,
                    timestamp: Date.now(),
                  });
                }
                return { ...s, updatedAt: Date.now(), messages: msgs };
              }),
            );
            setIsStreaming(false);
          },
          onError: (err: Error) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== targetSession.id) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== assistantMsgId) return m;
                    return {
                      ...m,
                      content: m.content || `抱歉，请求处理失败: ${err.message || '未知错误'}`,
                      isStreaming: false,
                    };
                  }),
                };
              }),
            );
            setIsStreaming(false);
          },
        },
        membershipId,
      );
    } catch (err: any) {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSession.id) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== assistantMsgId) return m;
              return {
                ...m,
                content: m.content || `抱歉，请求处理失败: ${err.message || '未知错误'}`,
                isStreaming: false,
              };
            }),
          };
        }),
      );
      setIsStreaming(false);
    }
  };

  const handleExecuteProposal = async (proposal: CopilotProposal, msgIndex: number) => {
    if (!membershipId) return;
    setExecutingIdx(msgIndex);
    try {
      await runCommand(proposal.command, proposal.input, membershipId);
      toast.success(t('schedule.copilotExecOk', { p0: proposal.summary || proposal.command }));
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSession.id
            ? { ...s, messages: s.messages.map((msg, i) => (i === msgIndex ? { ...msg, executed: true } : msg)) }
            : s,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ['rooms', 'day', 'schedule', 'appointments', 'floorSnapshot', 'analytics', 'customers', 'queue', 'rotation'] });
    } catch (err: any) {
      toast.danger(t('schedule.copilotExecFailed', { p0: err.message || '权限冲突' }));
    } finally {
      setExecutingIdx(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  };

  const quickPrompts = [
    { label: '📊 今日营收与客单价', prompt: '今天目前的营收和客单价怎么样？' },
    { label: '🧹 房间3设为清洁', prompt: '把房间3标记为打扫中' },
    { label: '🕒 查明天技师空档', prompt: '查一下明天上午有哪些技师有空档？' },
    { label: '👥 近60天未到店老客', prompt: '帮我列出近60天未到店的老顾客' },
  ];

  const formatRelativeTime = (ts: number) => {
    const diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}小时前`;
    return `${Math.floor(diffHours / 24)}天前`;
  };

  const renderProposalCard = (proposal: CopilotProposal, msgIndex: number, executed?: boolean) => {
    const isRoomStatus = proposal.command === 'resource.setStatus';
    const isAppointmentCreate = proposal.command === 'appointment.create';
    const isAppointmentReschedule = proposal.command === 'appointment.reschedule';
    const isAppointmentCancel = proposal.command === 'appointment.cancel';

    if (isRoomStatus) {
      const status = String(proposal.input?.status ?? 'cleaning');
      const note = String(proposal.input?.note ?? '');
      return (
        <div className="ml-9 p-3.5 rounded-2xl bg-white border border-teal-200 text-xs space-y-2.5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-bold text-teal-950">
              <BedDouble className="w-4 h-4 text-teal-600" />
              <span>{t('schedule.copilotRoomChange')}</span>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
              {status === 'cleaning' ? t('schedule.copilotSetCleaning') : status === 'out_of_service' ? t('schedule.copilotSetMaintenance') : t('schedule.copilotSetAvailable')}
            </span>
          </div>

          <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100 space-y-1">
            <div className="text-slate-700 font-medium">{proposal.summary}</div>
            {note && <div className="text-[11px] text-slate-500">{t('schedule.copilotNoteLabel')}{note}</div>}
          </div>

          <div className="flex items-center justify-end pt-1">
            {executed ? (
              <span className="text-emerald-700 font-bold flex items-center gap-1 text-[11px] bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-200">
                <CheckCircle2 className="w-3.5 h-3.5" />  {t('schedule.copilotUpdateDone')}
              </span>
            ) : (
              <Button
                size="sm"
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold h-7 px-3 text-xs gap-1.5 shadow-xs"
                onClick={() => handleExecuteProposal(proposal, msgIndex)}
                disabled={executingIdx === msgIndex}
              >
                <Check className="w-3.5 h-3.5" />
                {executingIdx === msgIndex ? t('schedule.copilotUpdating') : t('schedule.copilotConfirmRoom')}
              </Button>
            )}
          </div>
        </div>
      );
    }

    if (isAppointmentCreate) {
      const items = Array.isArray(proposal.input?.items) ? proposal.input.items : [];
      const firstItem = items[0] as any;
      return (
        <div className="ml-9 p-3.5 rounded-2xl bg-white border border-teal-200 text-xs space-y-2.5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-bold text-teal-950">
              <Calendar className="w-4 h-4 text-teal-600" />
              <span>{t('schedule.copilotImportTitle')}</span>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
              
              {t('schedule.copilotImportParsed')}
            </span>
          </div>

          <div className="bg-teal-50/40 p-2.5 rounded-xl border border-teal-100 space-y-1.5">
            <div className="font-bold text-slate-900 text-xs">{proposal.summary}</div>
            {firstItem?.startsAt && (
              <div className="text-[11px] text-slate-600 flex items-center gap-1">
                <Clock className="w-3 h-3 text-teal-600" />
                
                {t('schedule.copilotApptTime')}{storeTime.dateTime(firstItem.startsAt)}
              </div>
            )}
            {firstItem?.durationMin && (
              <div className="text-[11px] text-slate-600">Duration：{firstItem.durationMin}  {t('schedule.copilotMinutes')}</div>
            )}
          </div>

          <div className="flex items-center justify-end pt-1">
            {executed ? (
              <span className="text-emerald-700 font-bold flex items-center gap-1 text-[11px] bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-200">
                <CheckCircle2 className="w-3.5 h-3.5" />  {t('schedule.copilotImported')}
              </span>
            ) : (
              <Button
                size="sm"
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold h-7 px-3 text-xs gap-1.5 shadow-xs"
                onClick={() => handleExecuteProposal(proposal, msgIndex)}
                disabled={executingIdx === msgIndex}
              >
                <Play className="w-3 h-3" />
                {executingIdx === msgIndex ? t('schedule.copilotImporting') : t('schedule.copilotConfirmImport')}
              </Button>
            )}
          </div>
        </div>
      );
    }

    if (isAppointmentReschedule || isAppointmentCancel) {
      const isReschedule = isAppointmentReschedule;
      return (
        <div
          className={`ml-9 p-3.5 rounded-2xl bg-white border ${
            isReschedule ? 'border-sky-200' : 'border-rose-200'
          } text-xs space-y-2.5 shadow-sm`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-bold text-slate-900">
              <Clock className={`w-4 h-4 ${isReschedule ? 'text-sky-600' : 'text-rose-600'}`} />
              <span>{isReschedule ? t('schedule.copilotRescheduleTitle') : t('schedule.copilotCancelTitle')}</span>
            </div>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                isReschedule
                  ? 'bg-sky-50 text-sky-700 border-sky-200'
                  : 'bg-rose-50 text-rose-700 border-rose-200'
              }`}
            >
              {isReschedule ? t('schedule.copilotRescheduleTag') : t('schedule.copilotCancelTag')}
            </span>
          </div>

          <div
            className={`p-2.5 rounded-xl border ${
              isReschedule ? 'bg-sky-50/60 border-sky-100 text-sky-950' : 'bg-rose-50/60 border-rose-100 text-rose-950'
            } leading-relaxed font-medium`}
          >
            {proposal.summary}
          </div>

          <div className="flex items-center justify-end pt-1">
            {executed ? (
              <span className="text-emerald-700 font-bold flex items-center gap-1 text-[11px] bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-200">
                <CheckCircle2 className="w-3.5 h-3.5" />  {t('schedule.copilotUpdateDone2')}
              </span>
            ) : (
              <Button
                size="sm"
                className={`${
                  isReschedule ? 'bg-sky-600 hover:bg-sky-700' : 'bg-rose-600 hover:bg-rose-700'
                } text-white font-bold h-7 px-3 text-xs gap-1.5 shadow-xs`}
                onClick={() => handleExecuteProposal(proposal, msgIndex)}
                disabled={executingIdx === msgIndex}
              >
                <Check className="w-3.5 h-3.5" />
                {executingIdx === msgIndex ? t('schedule.copilotExecuting') : isReschedule ? t('schedule.copilotConfirmReschedule') : t('schedule.copilotConfirmCancel')}
              </Button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="ml-9 p-3.5 rounded-2xl bg-white border border-teal-200 text-xs space-y-2.5 shadow-sm">
        <div className="flex items-center justify-between font-bold text-teal-950">
          <span className="flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-teal-600" />  {t('schedule.copilotSuggestedAction')}</span>
          <code className="text-[10px] bg-teal-100/60 px-1.5 py-0.5 rounded text-teal-800">{proposal.command}</code>
        </div>
        <p className="text-slate-700 bg-slate-50 p-2.5 rounded-xl border border-slate-100">{proposal.summary}</p>
        <div className="flex justify-end pt-1">
          {executed ? <span className="text-emerald-700 font-bold flex items-center gap-1 text-[11px] bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-200"><CheckCircle2 className="w-3.5 h-3.5" />  {t('schedule.copilotExecuted')}</span> : <Button size="sm" className="bg-teal-600 hover:bg-teal-700 text-white font-bold h-7 px-3 text-xs" onClick={() => handleExecuteProposal(proposal, msgIndex)} disabled={executingIdx === msgIndex}>{executingIdx === msgIndex ? t('schedule.copilotExecuting2') : t('schedule.copilotConfirmRun')}</Button>}
        </div>
      </div>
    );
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
      className={`w-full max-w-md h-full bg-white shadow-2xl flex flex-col relative z-raised animate-in slide-in-from-right-full duration-300 border-l border-slate-200 ${isDragging ? 'ring-4 ring-teal-500 ring-inset bg-teal-50/20' : ''}`}
    >
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />

      {/* Header */}
      <div className="h-16 flex items-center justify-between px-4 sm:px-6 border-b border-slate-100 shrink-0 bg-slate-900 text-white">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-teal-500/20 rounded-lg flex items-center justify-center text-teal-400 shrink-0 ring-1 ring-teal-400/30">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold tracking-wide text-xs sm:text-sm">{t('copilotTitle') || t('schedule.copilotTitle')}</span>
              <span className="text-[10px] bg-teal-500/20 text-teal-300 px-1.5 py-0.5 rounded font-mono font-bold">
                {activeSession.userQueryCount}/{MAX_SESSION_TURNS}  {t('schedule.copilotRound')}
              </span>
            </div>
            <p className="text-[10px] text-slate-400 font-medium truncate max-w-[130px]">{activeSession.title}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => handleNewSession()} className="p-1.5 text-slate-400 hover:text-white rounded-lg flex items-center gap-1 text-xs cursor-pointer">
            <Plus className="w-4 h-4 text-teal-400" />
          </button>
          <button type="button" onClick={() => setShowHistory((prev) => !prev)} className={`p-1.5 rounded-lg flex items-center gap-1 text-xs cursor-pointer ${showHistory ? 'text-teal-300' : 'text-slate-400'}`}>
            <History className="w-4 h-4" />
          </button>
          <Button variant="ghost" size="icon" onClick={onClose} className="text-slate-400 hover:text-white ml-1 rounded-full"><X className="w-5 h-5" /></Button>
        </div>
      </div>

      {showHistory ? (
        <div className="flex-1 overflow-y-auto bg-slate-50 flex flex-col p-4 space-y-3 custom-scrollbar">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <div className="flex items-center gap-2 font-bold text-xs"><History className="w-4 h-4 text-teal-600" />  {t('schedule.copilotHistory')}</div>
            <button onClick={() => handleNewSession()} className="text-xs bg-teal-600 text-white font-bold px-2.5 py-1 rounded-lg">{t('schedule.copilotNew')}</button>
          </div>
          {sessions.map((sess) => (
            <div key={sess.id} onClick={() => handleSelectSession(sess.id)} className={`p-3 rounded-xl border text-xs cursor-pointer ${sess.id === activeSessionId ? 'bg-teal-50 border-teal-300' : 'bg-white border-slate-200'}`}>
              <div className="flex justify-between font-bold text-slate-900 truncate">
                <div className="flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5" />{sess.title}</div>
                <span className="text-[10px] text-slate-400">{formatRelativeTime(sess.updatedAt)}</span>
              </div>
              <div className="flex justify-between pl-5 pt-1">
                <span className="text-[10px] text-slate-400">{sess.userQueryCount}{t('schedule.copilotRoundLimit')}</span>
                <Trash2 className="w-3.5 h-3.5 text-slate-400 hover:text-rose-600" onClick={(e) => handleDeleteSession(e, sess.id)} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto bg-slate-50 flex flex-col custom-scrollbar p-4 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">{t('quickCommands') || t('schedule.copilotQuickCommands')}</h3>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="text-[11px] text-teal-600 font-bold flex items-center gap-1 cursor-pointer"><ImageIcon className="w-3 h-3" />  {t('schedule.copilotScreenshot')}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {quickPrompts.map((item, i) => (
                <button key={i} type="button" onClick={() => void handleSendMessage(item.prompt)} className="bg-white border border-slate-200 text-slate-700 text-xs font-medium px-2.5 py-1.5 rounded-full shadow-2xs active:scale-95 cursor-pointer">
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-3 pt-2">
            {activeSession.messages.map((m, idx) => {
              if (m.role === 'system') return <div key={m.id || idx} className="p-2.5 rounded-xl bg-teal-50 border border-teal-200 text-teal-900 text-[11px] text-center font-medium">{m.content}</div>;
              return (
                <div key={m.id || idx} className="space-y-2">
                  <div className={`flex items-start gap-2.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {m.role === 'assistant' && <div className="w-7 h-7 rounded-full bg-slate-900 text-teal-400 flex items-center justify-center shrink-0 border border-slate-700 mt-0.5 shadow-xs"><Sparkles className="w-3.5 h-3.5" /></div>}
                    <div className={`rounded-2xl px-4 py-3 text-xs leading-relaxed max-w-[88%] shadow-2xs ${m.role === 'user' ? 'bg-slate-900 text-white' : 'bg-white text-slate-800 border border-slate-200'}`}>
                      {m.imagePreview && <div className="rounded-lg overflow-hidden border border-white/20 mb-2 shadow-xs"><img src={m.imagePreview} className="w-full h-auto object-cover max-h-40" /></div>}
                      {m.role === 'assistant' && (m.steps && m.steps.length > 0) && (
                        <ThinkingAccordion steps={m.steps} isStreaming={m.isStreaming} />
                      )}
                      {m.role === 'assistant' ? (
                        <BeautifiedMessageContent content={m.content} isStreaming={m.isStreaming} />
                      ) : (
                        <div className="font-medium">{m.content}</div>
                      )}
                    </div>
                    {m.role === 'user' && <div className="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center shrink-0 mt-0.5 font-bold text-xs shadow-xs"><User className="w-3.5 h-3.5" /></div>}
                  </div>
                  {m.proposal && renderProposalCard(m.proposal, idx, m.executed)}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      <div className="p-3.5 bg-white border-t border-slate-200 shrink-0 space-y-2">
        {selectedImage && (
          <div className="flex items-center justify-between bg-teal-50 border border-teal-200 rounded-xl p-2 text-xs">
            <div className="flex items-center gap-2 truncate">
              <img src={selectedImage.previewUrl} className="w-8 h-8 rounded object-cover border" />
              <div><span className="font-bold text-teal-900">{selectedImage.name}</span><span className="text-[10px] text-teal-600 block">{t('schedule.copilotScreenshotAttached')}</span></div>
            </div>
            <Trash2 className="w-4 h-4 cursor-pointer text-slate-400 hover:text-rose-600" onClick={() => setSelectedImage(null)} />
          </div>
        )}
        <div className="relative flex items-end gap-2 bg-slate-50 border border-slate-200 rounded-2xl p-2 focus-within:ring-1 focus-within:ring-teal-500 transition-all shadow-sm">
          <button type="button" onClick={() => fileInputRef.current?.click()} className="p-2 text-slate-400 hover:text-teal-600"><ImageIcon className="w-4 h-4" /></button>
          <textarea
            placeholder={selectedImage ? t('schedule.copilotFollowUpPlaceholder') : t('askCopilot') || t('schedule.copilotPromptPlaceholder')}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent border-none focus:ring-0 resize-none min-h-[44px] max-h-32 text-xs text-slate-700 py-2.5 px-1 outline-none"
            rows={1}
          />
          <button type="button" onClick={() => void handleSendMessage()} disabled={isStreaming || (!inputText.trim() && !selectedImage)} className="p-2 bg-teal-600 text-white rounded-xl shadow-sm cursor-pointer disabled:bg-slate-300"><Send className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}
