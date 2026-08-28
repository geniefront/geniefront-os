import { useMemo, useState, useEffect } from "react";
import { useErrorMessage } from '@/lib/errorMessage';
import { useStoreTime } from '@/lib/time';
import { toast } from "@heroui/react";
import { useLanguage } from "@/LanguageContext";
import { Card } from "@/components/ui/Card";
import { SampleDataNotice } from '@/components/ui/SampleDataNotice';
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Modal, ConfirmDialog } from "@/components/ui/Modal";
import { PageLoading, PageError } from "@/components/ui/QueryState";
import { Input } from "@/components/ui/Input";
import {
  Search,
  Send,
  MessageSquare,
  AlertCircle,
  RefreshCw,
  Calendar,
  Plus,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  User,
  Clock,
  CheckCheck,
  AlertTriangle,
  ArrowUpRight,
  ExternalLink,
  ChevronRight,
  HeartHandshake,
  CheckCircle2,
  FileCheck,
  Settings2,
} from "lucide-react";
import { useInboundSmsQuery, useSendDirectSms } from "@/features/comms/api";
import type { InboundSms } from "@/features/comms/types";
import { useNavigate } from "react-router-dom";

// 扩充高质量企业级 Mock 对话数据
const DEFAULT_CONVERSATIONS: InboundSms[] = [
  {
    id: "sms-101",
    fromE164: "+1 (212) 555-0192",
    body: "你好！我想确认一下今天下午 4:30 和 Lisa 师傅的预约，我可能会稍微迟到 5 分钟。",
    intent: "inquiry",
    receivedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    customers: [{ id: "cust-1", name: "Emily Chen" }],
    upcoming: [
      {
        appointmentId: "appt-901",
        startsAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        confirmationCode: "GF-8891",
      },
    ],
  },
  {
    id: "sms-102",
    fromE164: "+1 (646) 772-8819",
    body: "STOP",
    intent: "opt_out",
    receivedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    customers: [{ id: "cust-2", name: "Michael Vance" }],
    upcoming: [
      {
        appointmentId: "appt-902",
        startsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        confirmationCode: "GF-7712",
      },
    ],
  },
  {
    id: "sms-103",
    fromE164: "+1 (917) 662-3301",
    body: "请问你们店附近有免费停车位吗？我开 SUV 过来。",
    intent: "inquiry",
    receivedAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
    customers: [{ id: "cust-3", name: "Sarah Jenkins" }],
    upcoming: [],
  },
  {
    id: "sms-104",
    fromE164: "+1 (347) 819-2041",
    body: "做完美甲感觉颜色超级好看！谢谢你们前台推荐的款式，下次还来！",
    intent: "feedback",
    receivedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    customers: [{ id: "cust-4", name: "Chloe Zhao" }],
    upcoming: [],
  },
];

export function Messages() {
  const storeTime = useStoreTime();
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useInboundSmsQuery(14);
  const sendSmsMutation = useSendDirectSms();

  // 10DLC 状态（从 localStorage 读取或默认为待审核/未认证，由后台管理员代办）
  const [tenDlcStatus, setTenDlcStatus] = useState<"not_submitted" | "pending_review" | "approved">(() => {
    try {
      const saved = localStorage.getItem("gf.10dlc.status");
      if (saved === "approved" || saved === "pending_review" || saved === "not_submitted") {
        return saved;
      }
    } catch {}
    return "pending_review";
  });

  const [activeTab, setActiveTab] = useState<"all" | "needs_reply" | "has_upcoming" | "opt_out">("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSms, setSelectedSms] = useState<InboundSms | null>(null);
  const [replyText, setReplyText] = useState("");

  // 新建外发短信 Modal
  const [newSmsModalOpen, setNewSmsModalOpen] = useState(false);
  const [newSmsToPhone, setNewSmsToPhone] = useState("");
  const [newSmsBody, setNewSmsBody] = useState("");

  // 10DLC 引导弹窗
  const [tenDlcModalOpen, setTenDlcModalOpen] = useState(false);

  const messages = useMemo(() => {
    if (data?.messages && data.messages.length > 0) {
      return data.messages;
    }
    return DEFAULT_CONVERSATIONS;
  }, [data]);

  // 默认选中第一条
  useEffect(() => {
    if (!selectedSms && messages.length > 0) {
      setSelectedSms(messages[0]);
    }
  }, [messages, selectedSms]);

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return messages.filter((m) => {
      const matchSearch =
        q === "" ||
        m.fromE164.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        m.customers.some((c) => c.name.toLowerCase().includes(q));

      if (!matchSearch) return false;

      if (activeTab === "needs_reply") {
        return m.intent !== "opt_out";
      }
      if (activeTab === "has_upcoming") {
        return m.upcoming.length > 0;
      }
      if (activeTab === "opt_out") {
        return m.intent === "opt_out";
      }
      return true;
    });
  }, [messages, searchTerm, activeTab]);

  // 短信分段与字符类型测算 (GSM-7 vs UCS-2)
  const calculateSegments = (text: string) => {
    const isUcs2 = /[^\u0000-\u00ff]/.test(text);
    const len = text.length;
    if (len === 0) return { count: 0, isUcs2, maxPerSegment: isUcs2 ? 70 : 160 };
    const maxPerSeg = isUcs2 ? (len > 70 ? 67 : 70) : (len > 160 ? 153 : 160);
    return {
      count: Math.ceil(len / maxPerSeg),
      isUcs2,
      maxPerSegment: maxPerSeg,
    };
  };

  const replySegInfo = calculateSegments(replyText);
  const newSmsSegInfo = calculateSegments(newSmsBody);

  const [confirmSendReplyOpen, setConfirmSendReplyOpen] = useState(false);
  const [confirmNewSmsOpen, setConfirmNewSmsOpen] = useState(false);

  const isSendingLocked = tenDlcStatus !== "approved";

  const handleExecuteSendReply = async () => {
    if (!replyText.trim() || !selectedSms) return;
    try {
      const res = await sendSmsMutation.mutateAsync({
        toE164: selectedSms.fromE164,
        body: replyText.trim(),
        customerId: selectedSms.customers[0]?.id || undefined,
      });

      if (res?.suppressed) {
        toast.danger(t('crm.msgOptedOutBlocked'));
      } else {
        toast.success(t('crm.msgSent', { p0: res?.segments ?? 1 }));
      }
      setReplyText("");
      setConfirmSendReplyOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleExecuteSendNewSms = async () => {
    if (!newSmsToPhone.trim() || !newSmsBody.trim()) {
      toast.danger(t('crm.msgFieldsRequired'));
      return;
    }
    try {
      const res = await sendSmsMutation.mutateAsync({
        toE164: newSmsToPhone.trim(),
        body: newSmsBody.trim(),
      });

      if (res?.suppressed) {
        toast.danger(t('crm.msgOptedOutBlocked2'));
      } else {
        toast.success(t('crm.msgSent2', { p0: res?.segments ?? 1 }));
      }
      setNewSmsModalOpen(false);
      setConfirmNewSmsOpen(false);
      setNewSmsToPhone("");
      setNewSmsBody("");
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 快捷回复话术模板
  const QUICK_TEMPLATES = [
    {
      title: "到店迟到确认",
      text: "没问题！已为您在排班日历中标记延迟 10 分钟，您的技师已做好接待准备，路途注意安全！",
    },
    {
      title: "泊车与位置指引",
      text: "您好！本店正后方配有免费客户专属停车位，导航定位至门店后门即可直接驶入。",
    },
    {
      title: "改期协商",
      text: "收到您的改期诉求，请问您方便调整至本周五下午或者周六上午吗？我们将第一时间为您锁定时段。",
    },
    {
      title: "服务好评关怀",
      text: "非常感谢您的认可与喜爱！期待下次为您提供更加贴心专业的服务，祝您生活愉快！",
    },
  ];

  if (isLoading && !data) {
    return <PageLoading title={t('crm.msgLoading')} description={t('crm.msgLoadingDesc')} />;
  }

  if (isError && !data) {
    return <PageError title={t('crm.msgLoadError')} error={error} onRetry={refetch} />;
  }

  return (
    <div className="space-y-5 pb-20 max-w-7xl mx-auto">
      <SampleDataNotice />
      {/* 10DLC 电信合规状态风控横幅 */}
      {tenDlcStatus === "approved" ? (
        <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-950 flex items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
            <div>
              <span className="font-bold">{t('crm.msgCompliantTitle')}</span>
              <span className="text-emerald-700 ml-2">
                
                {t('crm.msgCompliantDesc')}
              </span>
            </div>
          </div>
          <Badge className="bg-emerald-600 text-white font-bold shrink-0">{t('crm.msgCompliant')}</Badge>
        </div>
      ) : tenDlcStatus === "pending_review" ? (
        <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-950 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs shadow-sm">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-bold text-sm text-amber-900 flex items-center gap-1.5">
                <span>{t('crm.msgPendingTitle')}</span>
                <Badge variant="warning" className="text-[10px]">{t('crm.msgUnderReview')}</Badge>
              </p>
              <p className="text-amber-800 leading-relaxed">
                
                {t('crm.msgPendingDesc')}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="bg-amber-600 hover:bg-amber-700 text-white font-bold shrink-0 text-xs"
            onClick={() => navigate("/settings")}
          >
            
            {t('crm.msgView10dlc')}
          </Button>
        </div>
      ) : (
        <div className="p-4 rounded-2xl bg-red-50 border border-red-200 text-red-950 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs shadow-sm">
          <div className="flex items-start gap-3">
            <Lock className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-bold text-sm text-red-900">
                
                {t('crm.msgNotSubmittedTitle')}
              </p>
              <p className="text-red-800 leading-relaxed">
                
                {t('crm.msgNotSubmittedDesc')}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="bg-red-600 hover:bg-red-700 text-white font-bold shrink-0 text-xs"
            onClick={() => navigate("/settings")}
          >
            
            {t('crm.msgSubmit10dlc')}
          </Button>
        </div>
      )}

      {/* 退订拦截预警（若有预约却回复了 STOP） */}
      {data && data.needsAttention > 0 && (
        <div className="p-3.5 rounded-2xl bg-red-100/70 border border-red-300 text-red-900 flex items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span className="font-bold">
              
              {t('crm.msgOptOutWarnPrefix')} {data.needsAttention}  {t('crm.msgOptOutWarnSuffix')}
            </span>
          </div>
          <span className="text-red-700 text-[11px]">{t('crm.msgOptOutWarnAction')}</span>
        </div>
      )}

      <PageHeader
        title={t("messagesTitle") || t('crm.msgTitle')}
        description={t('crm.msgDesc')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                refetch();
                toast.success(t('crm.msgStreamSynced'));
              }}
              className="gap-2 text-xs"
              disabled={isLoading}
            >
              <RefreshCw className={"w-3.5 h-3.5 " + (isLoading ? "animate-spin" : "")} />
              {t("refresh") || t('crm.msgRefresh')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5 font-bold text-xs shadow-sm"
              size="sm"
              onClick={() => {
                if (isSendingLocked) {
                  setTenDlcModalOpen(true);
                } else {
                  setNewSmsModalOpen(true);
                }
              }}
            >
              {isSendingLocked ? <Lock className="w-3.5 h-3.5 text-teal-200" /> : <Plus className="w-3.5 h-3.5" />}
              <span>{t('crm.msgNew')}</span>
            </Button>
          </div>
        }
      />

      {/* 三栏式企业级沟通工作台 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-[calc(100vh-16rem)] min-h-[580px]">
        {/* 左栏：会话列表与搜索 (4 列) */}
        <Card className="lg:col-span-4 p-4 flex flex-col h-full border-slate-200 shadow-sm overflow-hidden space-y-3">
          {/* 筛选 Tabs */}
          <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-xl text-xs font-semibold">
            {[
              { id: "all", label: t('crm.msgFilterAll') },
              { id: "needs_reply", label: t('crm.msgFilterUnreplied') },
              { id: "has_upcoming", label: t('crm.msgFilterBooked') },
              { id: "opt_out", label: t('crm.msgFilterOptedOut') },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-1.5 rounded-lg text-[11px] transition-all ${
                  activeTab === tab.id
                    ? "bg-white text-teal-900 font-bold shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* 搜索框 */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder={t('crm.msgSearchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            />
          </div>

          {/* 对话列表 */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
            {filtered.length === 0 ? (
              <div className="text-center py-16 text-slate-400 text-xs">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                <p>{t('crm.msgNoMatches')}</p>
              </div>
            ) : (
              filtered.map((msg) => {
                const isSelected = selectedSms?.id === msg.id;
                const isOptOut = msg.intent === "opt_out";
                const hasAppt = msg.upcoming.length > 0;
                return (
                  <div
                    key={msg.id}
                    onClick={() => setSelectedSms(msg)}
                    className={`p-3 rounded-xl cursor-pointer transition-all text-xs space-y-1.5 border ${
                      isSelected
                        ? "bg-teal-50/90 border-teal-300 shadow-sm"
                        : "bg-white border-slate-100 hover:bg-slate-50 hover:border-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-7 h-7 rounded-full bg-teal-100 text-teal-800 font-bold flex items-center justify-center text-[11px] shrink-0">
                          {msg.customers[0]?.name ? msg.customers[0].name.charAt(0) : t('crm.msgGuestShort')}
                        </div>
                        <span className="font-bold text-slate-900 truncate">
                          {msg.customers[0]?.name || msg.fromE164}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400 font-mono shrink-0">
                        {storeTime.time(msg.receivedAt)}
                      </span>
                    </div>

                    <p className="text-slate-600 line-clamp-2 leading-relaxed text-[11px]">
                      {msg.body}
                    </p>

                    <div className="flex items-center gap-1.5 pt-0.5 flex-wrap">
                      {isOptOut && (
                        <Badge variant="error" className="text-[9px] px-1.5 py-0">
                          
                          {t('crm.msgOptedOutTag')}
                        </Badge>
                      )}
                      {hasAppt && (
                        <Badge variant="success" className="text-[9px] px-1.5 py-0 gap-1">
                          <Calendar className="w-2.5 h-2.5" />  {t('crm.msgUpcomingTag')}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* 中栏：交互式消息流与发送器 (5 列) */}
        <Card className="lg:col-span-5 p-5 flex flex-col h-full border-slate-200 shadow-sm overflow-hidden space-y-4">
          {selectedSms ? (
            <>
              {/* 头部：当前会话联络人 */}
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-slate-900 text-white font-bold flex items-center justify-center text-xs">
                    {selectedSms.customers[0]?.name ? selectedSms.customers[0].name.charAt(0) : t('crm.msgGuestShort2')}
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                      <span>{selectedSms.customers[0]?.name || t('crm.msgCustomer')}</span>
                      <span className="text-xs text-slate-400 font-mono font-normal">
                        {selectedSms.fromE164}
                      </span>
                    </h3>
                    <p className="text-[11px] text-slate-500 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      
                      {t('crm.msgCarrierStatus')}
                    </p>
                  </div>
                </div>

                <Button
                  size="sm"
                  variant="secondary"
                  className="text-xs gap-1.5"
                  onClick={() => navigate("/schedule")}
                >
                  <Calendar className="w-3.5 h-3.5 text-teal-600" />
                  
                  {t('crm.msgScheduleBoard')}
                </Button>
              </div>

              {/* 消息对话气泡流 */}
              <div className="flex-1 overflow-y-auto space-y-4 p-2 custom-scrollbar">
                {/* 系统 24 小时前自动发送的预约提醒 */}
                <div className="flex justify-center">
                  <div className="bg-slate-100 border border-slate-200 rounded-xl px-3 py-1.5 text-[11px] text-slate-600 max-w-sm text-center">
                    
                    {t('crm.msgAutoReminder')}
                  </div>
                </div>

                {/* 客户上行短信 */}
                <div className="flex flex-col items-start space-y-1">
                  <div className="max-w-[85%] bg-slate-100 text-slate-800 p-3.5 rounded-2xl rounded-tl-none text-xs leading-relaxed border border-slate-200">
                    <p>{selectedSms.body}</p>
                  </div>
                  <span className="text-[10px] text-slate-400 pl-1 font-mono">
                    {storeTime.time(selectedSms.receivedAt)}
                  </span>
                </div>

                {selectedSms.intent === "opt_out" && (
                  <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-900 text-xs space-y-1">
                    <p className="font-bold flex items-center gap-1.5">
                      <AlertCircle className="w-4 h-4 text-red-600" />
                      
                      {t('crm.msgOptedOutNotice')}
                    </p>
                    <p className="text-[11px] text-red-700">
                      
                      {t('crm.msgOptedOutNoticeDesc')}
                    </p>
                  </div>
                )}
              </div>

              {/* 快捷话术模板栏 */}
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-700 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-teal-600" />
                    
                    {t('crm.msgQuickReplies')}
                  </span>
                  <span className="text-[10px] text-slate-400">{t('crm.msgQuickRepliesHint')}</span>
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar">
                  {QUICK_TEMPLATES.map((tmpl, i) => (
                    <button
                      key={i}
                      onClick={() => setReplyText(tmpl.text)}
                      className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-teal-50 hover:text-teal-900 text-slate-600 text-[11px] font-medium whitespace-nowrap border border-slate-200 transition-colors"
                    >
                      {tmpl.title}
                    </button>
                  ))}
                </div>
              </div>

              {/* 回复输入区域 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <label className="font-semibold text-slate-600">{t('crm.msgReplyBody')}</label>
                  <span>
                    {replyText.length}  {t('crm.msgCharsSep')} {replySegInfo.count}  {t('crm.msgSegmentsPrefix')}
                    {replySegInfo.isUcs2 ? t('crm.msgEncodingUcs2') : t('crm.msgEncodingGsm7')})
                  </span>
                </div>

                <textarea
                  rows={3}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder={
                    isSendingLocked
                      ? t('crm.msgLockedPlaceholder')
                      : t('crm.msgReplyPlaceholder')
                  }
                  disabled={isSendingLocked}
                  className={`w-full p-3 text-sm rounded-xl border min-h-[85px] focus:outline-none focus:ring-2 ${
                    isSendingLocked
                      ? "bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed"
                      : "border-slate-200 focus:ring-teal-500/20 text-slate-800"
                  }`}
                />

                <div className="flex items-center justify-between pt-1">
                  {isSendingLocked ? (
                    <span className="text-[11px] text-amber-700 font-medium flex items-center gap-1">
                      <Lock className="w-3.5 h-3.5" />  {t('crm.msgUnlockAfter10dlc')}
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-400">{t('crm.msgSendShortcut')}</span>
                  )}

                  <Button
                    className={`text-xs font-bold gap-1.5 ${
                      isSendingLocked
                        ? "bg-slate-200 text-slate-400 hover:bg-slate-200 cursor-not-allowed"
                        : "bg-teal-600 hover:bg-teal-700 text-white shadow-sm"
                    }`}
                    size="sm"
                    onClick={() => {
                      if (isSendingLocked) {
                        setTenDlcModalOpen(true);
                      } else {
                        setConfirmSendReplyOpen(true);
                      }
                    }}
                    disabled={isSendingLocked || sendSmsMutation.isPending || !replyText.trim()}
                  >
                    {isSendingLocked ? (
                      <>
                        <Lock className="w-3.5 h-3.5" />
                        <span>{t('crm.msgLockedBy10dlc')}</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" />
                        <span>{sendSmsMutation.isPending ? t('crm.msgSending') : "Send SMS"}</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-xs">
              <MessageSquare className="w-10 h-10 text-slate-300 mb-2" />
              <p>{t('crm.msgPickThread')}</p>
            </div>
          )}
        </Card>

        {/* 右栏：客户 360° 画像与预约上下文 (3 列) */}
        <Card className="lg:col-span-3 p-5 flex flex-col h-full border-slate-200 shadow-sm overflow-y-auto space-y-4">
          {selectedSms ? (
            <>
              <div className="border-b border-slate-100 pb-3">
                <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider mb-2 text-slate-400">
                  
                  {t('crm.msgProfileTitle')}
                </h4>
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-teal-100 text-teal-800 font-black flex items-center justify-center text-sm border border-teal-200">
                    {selectedSms.customers[0]?.name ? selectedSms.customers[0].name.charAt(0) : "VIP"}
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm">
                      {selectedSms.customers[0]?.name || t('crm.msgUnregisteredWalkIn')}
                    </h3>
                    <Badge className="bg-amber-50 text-amber-900 border-amber-200 text-[10px] mt-0.5">
                      
                      {t('crm.msgGoldMember')}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* 待到店生效预约 */}
              <div className="space-y-2">
                <h5 className="font-bold text-slate-700 text-xs flex items-center justify-between">
                  <span>{t('crm.msgUpcomingBookings')}</span>
                  <span className="text-teal-600 text-[10px] font-bold">
                    {selectedSms.upcoming.length}  {t('crm.msgBookingUnit')}
                  </span>
                </h5>

                {selectedSms.upcoming.length > 0 ? (
                  selectedSms.upcoming.map((u, i) => (
                    <div
                      key={i}
                      className="p-3 rounded-xl bg-teal-50/70 border border-teal-200 text-xs space-y-1.5"
                    >
                      <div className="flex items-center justify-between font-bold text-teal-900">
                        <span>{t('crm.msgSampleService')}</span>
                        <Badge variant="success" className="text-[9px]">
                          
                          {t('crm.msgConfirmedTag')}
                        </Badge>
                      </div>
                      <p className="text-slate-600 font-mono text-[11px]">
                        📅 {storeTime.dateTime(u.startsAt, { month: "numeric", day: "numeric", year: undefined })}
                      </p>
                      <p className="text-slate-500 text-[11px]">
                        
                        {t('crm.msgTherapistRoom')}
                      </p>
                      <p className="text-[10px] text-slate-400 font-mono">
                        
                        {t('crm.msgConfirmationCode')} {u.confirmationCode || "--"}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-400 italic p-3 bg-slate-50 rounded-xl text-center">
                    
                    {t('crm.msgNoUpcoming')}
                  </p>
                )}
              </div>

              {/* 健康禁忌与偏好 */}
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs space-y-1.5">
                <span className="font-bold text-slate-700">{t('crm.msgHealthPrefs')}</span>
                <p className="text-slate-600 leading-relaxed text-[11px]">
                  
                  {t('crm.msgPrefPressure')}
                  <br />
                  
                  {t('crm.msgPrefFocus')}
                  <br />
                  
                  {t('crm.msgPrefAllergy')}
                </p>
              </div>

              {/* 历史服务记录 */}
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <span className="font-bold text-slate-700 text-xs">{t('crm.msgRecentVisits')}</span>
                <div className="space-y-1.5 text-[11px] text-slate-600">
                  <div className="flex justify-between p-2 rounded-lg bg-slate-50">
                    <span>{t('crm.msgSampleService2')}</span>
                    <span className="font-mono text-slate-400">08/12 · $145</span>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-slate-50">
                    <span>{t('crm.msgSampleService3')}</span>
                    <span className="font-mono text-slate-400">07/28 · $55</span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-20 text-slate-400 text-xs">
              <User className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              <p>{t('crm.msgNoProfile')}</p>
            </div>
          )}
        </Card>
      </div>

      {/* 10DLC 锁定阻断引导弹窗 */}
      <Modal
        isOpen={tenDlcModalOpen}
        onOpenChange={setTenDlcModalOpen}
        size="md"
        title={t('crm.msgComplianceModalTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setTenDlcModalOpen(false)}>
              
              {t('crm.msgLater')}
            </Button>
            <Button
              size="sm"
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs gap-1"
              onClick={() => {
                setTenDlcModalOpen(false);
                navigate("/settings");
              }}
            >
              
              {t('crm.msgGoToSettings')}
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        }
      >
        <div className="space-y-3 py-2 text-xs text-slate-700">
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 space-y-1">
            <p className="font-bold">{t('crm.msgWhyBlockedTitle')}</p>
            <p className="leading-relaxed text-[11px]">
              
              {t('crm.msgWhyBlockedBody')}
            </p>
          </div>

          <div className="space-y-1.5 pt-1">
            <p className="font-bold text-slate-900">{t('crm.msgFilingSteps')}</p>
            <ol className="list-decimal list-inside space-y-1 text-slate-600 leading-relaxed">
              <li>{t('crm.msgFilingStep1')}</li>
              <li>{t('crm.msgFilingStep2')}</li>
              <li>{t('crm.msgFilingStep3')}</li>
            </ol>
          </div>
        </div>
      </Modal>

      {/* 新建外发短信弹窗 */}
      <Modal
        isOpen={newSmsModalOpen}
        onOpenChange={setNewSmsModalOpen}
        title={t('crm.msgNewModalTitle')}
        description={t('crm.msgNewModalDesc')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setNewSmsModalOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              className="bg-teal-600 text-white font-bold"
              onClick={() => {
                if (!newSmsToPhone.trim() || !newSmsBody.trim()) {
                  toast.danger(t('crm.msgFieldsRequired2'));
                  return;
                }
                setConfirmNewSmsOpen(true);
              }}
              disabled={sendSmsMutation.isPending}
            >
              {sendSmsMutation.isPending ? t('crm.msgSending2') : t('crm.msgSendNow')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-2 text-xs">
          <div>
            <label className="block font-semibold text-slate-600 mb-1">
              
              {t('crm.msgRecipientPhone')}
            </label>
            <Input
              value={newSmsToPhone}
              onChange={(e) => setNewSmsToPhone(e.target.value)}
              placeholder="+12125551234"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block font-semibold text-slate-600">{t('crm.msgBody')}</label>
              <span className="text-[10px] text-slate-400">
                {newSmsBody.length}  {t('crm.msgCharsSep2')} {newSmsSegInfo.count}  {t('crm.msgSegmentUnit')}
              </span>
            </div>
            <textarea
              rows={4}
              value={newSmsBody}
              onChange={(e) => setNewSmsBody(e.target.value)}
              placeholder={t('crm.msgBodyPlaceholder')}
              className="w-full p-3 text-sm rounded-xl border border-slate-200 min-h-[100px] focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            />
          </div>
        </div>
      </Modal>

      {/* 回复短信二次确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmSendReplyOpen}
        onOpenChange={setConfirmSendReplyOpen}
        title={t('crm.msgConfirmReplyTitle')}
        description={
          selectedSms ? (
            <div className="space-y-2 text-xs text-slate-600 mt-2">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                <div className="flex items-center justify-between font-bold text-slate-800">
                  <span>{t('crm.msgRecipientLabel')} {selectedSms.customers[0]?.name || selectedSms.fromE164}</span>
                  <span className="font-mono text-teal-700">{selectedSms.fromE164}</span>
                </div>
                <p className="text-slate-700 bg-white p-2.5 rounded-lg border border-slate-100 italic leading-relaxed">
                  "{replyText}"
                </p>
                <div className="flex justify-between text-[11px] text-slate-400 pt-1">
                  <span>{t('crm.msgBillingEstimate')} {replySegInfo.count}  {t('crm.msgSegmentUnit2')}</span>
                  <span>{t('crm.msgEncodingLabel')} {replySegInfo.isUcs2 ? t('crm.msgEncodingUcs2b') : t('crm.msgEncodingGsm7b')}</span>
                </div>
              </div>
              <p className="text-[11px] text-slate-400">
                
                {t('crm.msgDeliveryNote')}
              </p>
            </div>
          ) : undefined
        }
        confirmLabel={t('crm.msgConfirmSend')}
        onConfirm={handleExecuteSendReply}
      />

      {/* 新建短信二次确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmNewSmsOpen}
        onOpenChange={setConfirmNewSmsOpen}
        title={t('crm.msgConfirmNewTitle')}
        description={
          <div className="space-y-2 text-xs text-slate-600 mt-2">
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
              <p>
                <span className="font-bold text-slate-800">{t('crm.msgRecipientNumber')} </span>
                <span className="font-mono font-bold text-teal-700">{newSmsToPhone}</span>
              </p>
              <p className="text-slate-700 bg-white p-2.5 rounded-lg border border-slate-100 italic leading-relaxed">
                "{newSmsBody}"
              </p>
              <div className="flex justify-between text-[11px] text-slate-400 pt-1">
                <span>{t('crm.msgBillingEstimate2')} {newSmsSegInfo.count}  {t('crm.msgSegmentUnit3')}</span>
                <span>{t('crm.msgEncodingLabel2')} {newSmsSegInfo.isUcs2 ? t('crm.msgEncodingUcs2c') : t('crm.msgEncodingGsm7c')}</span>
              </div>
            </div>
          </div>
        }
        confirmLabel={t('crm.msgConfirmSend2')}
        onConfirm={handleExecuteSendNewSms}
      />
    </div>
  );
}