import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useLanguage } from '@/LanguageContext';
import {
  X,
  Sparkles,
  Send,
  User,
  Image as ImageIcon,
  Trash2,
  Plus,
  History,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';
import { Button } from './ui/Button';
import { Spinner, toast } from '@heroui/react';
import {
  streamAskCopilot,
  undoCopilotAction,
  getCopilotSessions,
  removeCopilotSession,
  createInitialSession,
  loadStoredSessions,
  sessionsForStorage,
  useRehydrateTasks,
  MAX_SESSION_TURNS,
  BeautifiedMessageContent,
  ThinkingAccordion,
  ClarificationCard,
  TaskPlanCard,
  type CopilotSession,
  type MessageItem,
  type SelectedImageState,
} from '@/features/copilot';
import { useStoreTime } from '@/lib/time';
import { useSession } from '@/lib/session';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { copilotQueryCountAfterFailure } from '@/lib/deskCopy';

interface CopilotDrawerProps {
  onClose: () => void;
}

export function CopilotDrawer({ onClose }: CopilotDrawerProps) {
  const storeTime = useStoreTime();
  const { t } = useLanguage();
  const { membershipId } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const storageKey = useMemo(
    () => `gf_copilot_sessions_v3_${membershipId || 'anonymous'}`,
    [membershipId],
  );

  const [sessions, setSessions] = useState<CopilotSession[]>(() => {
    return loadStoredSessions(storageKey, t);
  });
  const loadedStorageKeyRef = useRef(storageKey);

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return sessions[0]?.id || '';
  });

  const [showHistory, setShowHistory] = useState(false);
  const [inputText, setInputText] = useState('');
  const [selectedImage, setSelectedImage] = useState<SelectedImageState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [undoingIdx, setUndoingIdx] = useState<number | null>(null);

  // 刷新页面后按 taskId 把方案卡片重新拉回来（本地只存指针，不存方案本体）
  useRehydrateTasks(sessions, setSessions, membershipId);

  const activeSession = useMemo(() => {
    return sessions.find((s) => s.id === activeSessionId) || sessions[0] || createInitialSession(t);
  }, [sessions, activeSessionId]);

  useEffect(() => {
    if (loadedStorageKeyRef.current === storageKey) return;
    const next = loadStoredSessions(storageKey, t);
    loadedStorageKeyRef.current = storageKey;
    setSessions(next);
    setActiveSessionId(next[0]?.id ?? '');
    setShowHistory(false);
    setInputText('');
    setSelectedImage(null);
  }, [storageKey, t]);

  useEffect(() => {
    if (loadedStorageKeyRef.current !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(sessionsForStorage(sessions)));
    } catch {
      // ignore
    }
  }, [sessions, storageKey]);

  useEffect(() => {
    if (!membershipId) return;
    let cancelled = false;
    void getCopilotSessions(membershipId).then((stored) => {
      if (cancelled || stored.length === 0) return;
      const remote: CopilotSession[] = stored.map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: Date.parse(session.createdAt),
        updatedAt: Date.parse(session.updatedAt),
        userQueryCount: session.userQueryCount,
        messages: session.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          timestamp: Date.parse(message.timestamp),
        })),
      }));
      setSessions(remote);
      setActiveSessionId(remote[0]?.id ?? '');
    }).catch(() => {
      // 离线或服务端暂不可用时保留按员工隔离的 7 天本地缓存。
    });
    return () => { cancelled = true; };
  }, [membershipId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeSession.messages, isStreaming]);

  const handleNewSession = (title?: string) => {
    const newSess = createInitialSession(t, title);
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
    if (membershipId) {
      void removeCopilotSession(id, membershipId).catch(() => {
        toast.danger(t('schedule.copilotSessionDeleteFailed'));
      });
    }
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        const fresh = createInitialSession(t);
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
    const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    if (!supportedTypes.has(file.type)) {
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
      const newSess = createInitialSession(t, query ? query.slice(0, 16) : t('schedule.copilotImportChatTitle'));
      setSessions((prev) => [newSess, ...prev]);
      setActiveSessionId(newSess.id);
      targetSession = newSess;
      toast.info(t('schedule.copilotSessionFull'));
    }

    const nextCount = targetSession.userQueryCount + 1;
    let newTitle = targetSession.title;
    if (targetSession.title === t('schedule.copilotNewChatTitle') && query) {
      newTitle = query.slice(0, 16);
    }

    const userMsg: MessageItem = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      content: query || t('schedule.copilotScreenshotSentPlaceholder'),
      timestamp: Date.now(),
      imagePreview: selectedImage?.previewUrl,
    };

    const assistantMsgId = `msg_${Date.now()}_a`;
    const placeholderAssistantMsg: MessageItem = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      steps: [t('schedule.copilotConnecting')],
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

    try {
      await streamAskCopilot(
        {
          question: query || t('schedule.copilotIdentifyScreenshotPrompt'),
          sessionId: targetSession.id,
          image: imagePayload,
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
          onDone: (res: any) => {
            const serverSessionId = typeof res.sessionId === 'string'
              ? res.sessionId
              : targetSession.id;
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== targetSession.id) return s;
                const msgs = s.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  return {
                    ...m,
                    content: m.content || res.answer,
                    taskId: res.taskId ?? m.taskId,
                    planRevision: res.planRevision ?? m.planRevision,
                    revision: res.revision ?? m.revision,
                    clarification: res.clarification ?? m.clarification,
                    isStreaming: false,
                  };
                });
                if (nextCount >= MAX_SESSION_TURNS) {
                  msgs.push({
                    id: `msg_${Date.now()}_sys`,
                    role: 'system',
                    content: t('schedule.copilotSessionLimitReached', { p0: MAX_SESSION_TURNS }),
                    timestamp: Date.now(),
                  });
                }
                return { ...s, id: serverSessionId, updatedAt: Date.now(), messages: msgs };
              }),
            );
            if (serverSessionId !== targetSession.id) setActiveSessionId(serverSessionId);
            setIsStreaming(false);
          },
          onError: (err: Error) => {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== targetSession.id) return s;
                return {
                  ...s,
                  userQueryCount: copilotQueryCountAfterFailure(s.userQueryCount),
                  messages: s.messages.map((m) => {
                    if (m.id !== assistantMsgId) return m;
                    return {
                      ...m,
                      content: m.content || t('schedule.copilotProcessFailed', { p0: err.message || t('schedule.copilotUnknownError') }),
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
            userQueryCount: copilotQueryCountAfterFailure(s.userQueryCount),
            messages: s.messages.map((m) => {
              if (m.id !== assistantMsgId) return m;
              return {
                ...m,
                content: m.content || t('schedule.copilotProcessFailed', { p0: err.message || t('schedule.copilotUnknownError') }),
                isStreaming: false,
              };
            }),
          };
        }),
      );
      setIsStreaming(false);
    }
  };

  const invalidateCopilotQueries = () => {
    const targetKeys = ['rooms', 'day', 'schedule', 'appointments', 'floorSnapshot', 'analytics', 'customers', 'queue', 'rotation'];
    for (const key of targetKeys) {
      void queryClient.invalidateQueries({ queryKey: [key] });
      void queryClient.invalidateQueries({ queryKey: ['desk', key] });
    }
  };

  const handleUndo = async (undoToken: string, msgIndex: number) => {
    if (!membershipId) return;
    setUndoingIdx(msgIndex);
    try {
      await undoCopilotAction(undoToken, membershipId);
      setSessions((prev) => prev.map((session) => session.id === activeSession.id
        ? {
          ...session,
          messages: session.messages.map((message, index) => index === msgIndex
            ? {
              ...message,
              undone: true,
              undoToken: undefined,
              undoExpiresAt: undefined,
            }
            : message),
        }
        : session));
      invalidateCopilotQueries();
      toast.success(t('schedule.copilotUndoOk'));
    } catch (err: any) {
      toast.danger(t('schedule.copilotUndoFailed', {
        p0: err.message || t('schedule.copilotPermissionConflict'),
      }));
    } finally {
      setUndoingIdx(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  };

  const quickPrompts = [
    { label: t('schedule.copilotQuickRevenue'), prompt: t('schedule.copilotQuickRevenuePrompt') },
    { label: t('schedule.copilotQuickCleanRoom'), prompt: t('schedule.copilotQuickCleanRoomPrompt') },
    { label: t('schedule.copilotQuickAvailability'), prompt: t('schedule.copilotQuickAvailabilityPrompt') },
    { label: t('schedule.copilotQuickInactiveCustomers'), prompt: t('schedule.copilotQuickInactiveCustomersPrompt') },
  ];

  const formatRelativeTime = (ts: number) => {
    const diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return t('schedule.copilotJustNow');
    if (diffMin < 60) return t('schedule.copilotMinutesAgo', { p0: diffMin });
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return t('schedule.copilotHoursAgo', { p0: diffHours });
    return t('schedule.copilotDaysAgo', { p0: Math.floor(diffHours / 24) });
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
      className={`w-full max-w-md h-full bg-white shadow-2xl flex flex-col relative z-raised animate-in slide-in-from-right-full duration-300 border-l border-slate-200 ${isDragging ? 'ring-4 ring-teal-500 ring-inset bg-teal-50/20' : ''}`}
    >
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleFileSelect} className="hidden" />

      {/* Header */}
      <div className="h-16 flex items-center justify-between px-4 sm:px-6 border-b border-slate-100 shrink-0 bg-slate-900 text-white">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-teal-500/20 rounded-lg flex items-center justify-center text-teal-400 shrink-0 ring-1 ring-teal-400/30">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold tracking-wide text-xs sm:text-sm">{t('copilotTitle') || t('schedule.copilotTitle')}</span>
              {isStreaming && (
                <span className="text-[10px] bg-teal-500/20 text-teal-300 px-2 py-0.5 rounded-full font-medium flex items-center gap-1.5 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-400"></span>
                  {t('schedule.copilotThinking')}
                </span>
              )}
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
                <span className="text-[10px] text-slate-400">{sess.messages.filter((m) => m.role === 'user').length} {t('schedule.copilotConversations')}</span>
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
                      {m.imagePreview && <div className="rounded-lg overflow-hidden border border-white/20 mb-2 shadow-xs"><img src={m.imagePreview} alt={t('schedule.copilotScreenshotAlt')} className="w-full h-auto object-cover max-h-40" /></div>}
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
                  {m.clarification && (m.clarification.candidateOptions?.length ?? 0) > 0 && (
                    <div className="ml-9">
                      <ClarificationCard
                        clarification={m.clarification}
                        disabled={isStreaming}
                        onPick={(label) => void handleSendMessage(label)}
                      />
                    </div>
                  )}

                  {m.taskId && m.planRevision && (
                    <div className="ml-9">
                      <TaskPlanCard
                        taskId={m.taskId}
                        preview={m.planRevision}
                        revision={m.revision ?? 1}
                        executed={m.executed}
                        onExecuted={(execution) => {
                          // 撤销令牌只取第一个可撤销步骤的 —— 抽屉里的「撤销」
                          // 是给「刚建错一单」用的应急按钮，不是批量回滚工具。
                          // 整批要退，走预约列表逐条取消，那条路有取消原因和
                          // 是否通知客人的开关。
                          const undoToken = execution.executedSteps
                            .find((step) => step.status === 'succeeded' && step.undoToken)?.undoToken;
                          setSessions((prev) =>
                            prev.map((s) =>
                              s.id === activeSession.id
                                ? {
                                    ...s,
                                    messages: s.messages.map((item, idx2) =>
                                      idx2 === idx
                                        ? { ...item, executed: true, undoToken }
                                        : item,
                                    ),
                                  }
                                : s,
                            ),
                          );
                          invalidateCopilotQueries();
                        }}
                      />

                      {m.undoToken && !m.undone && (
                        <button
                          type="button"
                          disabled={undoingIdx === idx}
                          onClick={() => void handleUndo(m.undoToken!, idx)}
                          className="mt-1.5 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
                        >
                          <RotateCcw className="w-3 h-3" />
                          {undoingIdx === idx
                            ? t('schedule.copilotUndoing')
                            : t('schedule.copilotUndo')}
                        </button>
                      )}
                      {m.undone && (
                        <div className="mt-1.5 text-[11px] font-medium text-slate-400">
                          {t('schedule.copilotUndone')}
                        </div>
                      )}
                    </div>
                  )}
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
              <img src={selectedImage.previewUrl} alt={selectedImage.name} className="w-8 h-8 rounded object-cover border" />
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
