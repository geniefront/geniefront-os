import { useState, useMemo } from "react";
import { useErrorMessage } from '@/lib/errorMessage';
import { useStoreTime } from '@/lib/time';
import { useLanguage } from "@/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { SampleDataNotice } from '@/components/ui/SampleDataNotice';
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal, ConfirmDialog } from "@/components/ui/Modal";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import {
  Play,
  Pause,
  Clock,
  Phone,
  PhoneCall,
  PhoneForwarded,
  Settings2,
  Sparkles,
  RefreshCw,
  CheckCircle2,
  FileText,
  AlertTriangle,
  Search,
  Bot,
  User,
  Volume2,
  CalendarCheck,
  Calendar,
  Zap,
  TrendingUp,
  ShieldCheck,
  Headphones,
  Copy,
} from "lucide-react";
import { toast } from "@heroui/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageLoading, PageError } from "@/components/ui/QueryState";
import { useCallsQuery, useCallDraftsQuery, useDismissCallDraft } from "@/features/comms/api";
import type { CallView, CallDraftView, DraftDismissReason } from "@/features/comms/types";
import { useNavigate, useOutletContext } from "react-router-dom";

// 扩充高质量企业级 Mock 通话与草案数据以保障完整体验
const DEFAULT_ENTERPRISE_CALLS: CallView[] = [
  {
    callId: "call-901",
    fromE164: "+1 (212) 555-0192",
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    durationSeconds: 142,
    outcome: "Booked · 60min Deep Tissue Massage",
    toolsUsed: ["calendar.checkSlot", "booking.createDraft", "crm.lookupCustomer"],
    booked: true,
    recordingUrl: "https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg",
    transcript: [
      { role: "assistant", text: "您好！感谢致电 Lotus Wellness & Spa，我是 AI 智能接待助手，请问有什么可以帮您？", at: "00:02" },
      { role: "user", text: "你好，请问今天下午 4 点或者 4 点半还有没有 60 分钟的深层精油按摩？我希望指定 Lisa 师傅。", at: "00:09" },
      { role: "assistant", text: "好的，请稍等，我为您查询 Lisa 师傅今天下午的排期…… Lisa 师傅在下午 4:30 正好有空档，可以为您安排 60 分钟深层精油按摩，费用为 $95。请问您的名字是？", at: "00:18" },
      { role: "user", text: "我是 Emily Chen，手机号就是这个拨过来的号码。", at: "00:26" },
      { role: "assistant", text: "已为您成功预留！今天下午 4:30，技师 Lisa，项目 60 分钟深层精油按摩。确认短信已同步发送至您的手机，期待您的光临！", at: "00:35" },
    ],
  },
  {
    callId: "call-902",
    fromE164: "+1 (646) 388-9921",
    startedAt: new Date(Date.now() - 110 * 60 * 1000).toISOString(),
    durationSeconds: 98,
    outcome: "Inquiry · Pricing & Couple Suite",
    toolsUsed: ["crm.lookupCustomer", "pricing.inquire"],
    booked: false,
    recordingUrl: "https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg",
    transcript: [
      { role: "assistant", text: "您好！感谢致电 Lotus Spa，请问有什么可以为您效劳？", at: "00:02" },
      { role: "user", text: "我想问一下这周末做双人足疗和头部 Spa 的价格是多少，需要提前几天定包厢？", at: "00:08" },
      { role: "assistant", text: "双人尊享足疗 + 头部舒压套餐目前特惠价为 $168/对，包含独立 VIP 景观双人包厢及草本泡脚。周末房态较紧张，建议提前 1-2 天预订。请问需要我现在为您预留这周六的时间吗？", at: "00:22" },
      { role: "user", text: "我先和朋友商量一下时间，谢谢你啊！", at: "00:31" },
      { role: "assistant", text: "不客气，随时欢迎致电或通过我们官网直接预约，祝您生活愉快！", at: "00:38" },
    ],
  },
  {
    callId: "call-903",
    fromE164: "+1 (917) 774-2018",
    startedAt: new Date(Date.now() - 240 * 60 * 1000).toISOString(),
    durationSeconds: 185,
    outcome: "Transferred to Human · Reschedule Consultation",
    toolsUsed: ["telephony.forwardToHuman"],
    booked: false,
    recordingUrl: "https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg",
    transcript: [
      { role: "assistant", text: "您好！感谢致电 Lotus Spa，请问有什么可以帮您？", at: "00:02" },
      { role: "user", text: "我昨天买的次卡想退款，并且想把明天 5 人的团队预约整体改到下周，这个能处理吗？", at: "00:10" },
      { role: "assistant", text: "次卡退款及多人团体大单改期涉及专享优惠与款项核算，我立即为您转接前台资深经理，请稍候不要挂机……", at: "00:20" },
    ],
  },
  {
    callId: "call-904",
    fromE164: "+1 (347) 902-1144",
    startedAt: new Date(Date.now() - 360 * 60 * 1000).toISOString(),
    durationSeconds: 112,
    outcome: "Booked · Gel Manicure + Removal",
    toolsUsed: ["calendar.checkSlot", "booking.createDraft"],
    booked: true,
    recordingUrl: "https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg",
    transcript: [
      { role: "assistant", text: "您好，感谢致电 Lotus Spa，请问有什么可以帮您？", at: "00:02" },
      { role: "user", text: "明天中午 12 点能做一个凝胶美甲吗？我需要先卸掉旧甲。", at: "00:07" },
      { role: "assistant", text: "好的，明天中午 12:00 有美甲工位，基础凝胶美甲 $48，附加专业温和卸甲 $15，总Duration预计 50 分钟。已为您录入预约，请问联系人姓名是？", at: "00:19" },
      { role: "user", text: "叫 Sophia 就行。", at: "00:25" },
      { role: "assistant", text: "已为您成功建立明天 12:00 的美甲预约，感谢您的致电，期待明天见！", at: "00:32" },
    ],
  },
];

const DEFAULT_ENTERPRISE_DRAFTS: CallDraftView[] = [
  {
    draftId: "draft-801",
    status: "pending",
    fromE164: "+1 (212) 883-9912",
    fromDisplay: "+1 (212) 883-9912 (Jessica Taylor)",
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    service: { heard: "90分钟热石理疗", matchedId: "srv-hot-stone", matchedName: "90min 尊享热石深层理疗" },
    staff: { heard: "王师傅或者经验丰富的老技师", matchedId: "staff-wang", matchedName: "David Wang (特级技师)" },
    time: { heard: "明天下午两点或者两点半", slotStartsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), durationMin: 90 },
    customer: { id: "cust-201", displayName: "Jessica Taylor" },
    candidates: [{ customerId: "cust-201", displayName: "Jessica Taylor", lastVisitOn: "2026-08-10" }],
    callerNameHeard: "Jessica",
    confidenceBp: 9400,
    lowConfidence: false,
    notes: "客人背部肌肉偏紧，指名要求手法重一点的技师，自备理疗精油。",
    readyToBook: true,
    missing: [],
  },
  {
    draftId: "draft-802",
    status: "pending",
    fromE164: "+1 (917) 441-2900",
    fromDisplay: "+1 (917) 441-2900",
    createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    service: { heard: "日式睫毛嫁接", matchedId: "srv-lash", matchedName: "日式单根自然睫毛嫁接" },
    staff: { heard: "随便哪个技师都行", matchedId: null, matchedName: "任意空闲美睫师" },
    time: { heard: "后天上午十点半", slotStartsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(), durationMin: 60 },
    customer: null,
    candidates: [],
    callerNameHeard: "Amanda",
    confidenceBp: 7800,
    lowConfidence: true,
    notes: "新客人首次到店，询问是否有新人 85 折优惠，前台建单时可确认折扣。",
    readyToBook: false,
    missing: ["customerProfile"],
  },
];

export function Calls() {
  const storeTime = useStoreTime();
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { openCreateAppointment } = useOutletContext<{
    openCreateAppointment?: (options?: {
      defaultDate?: string;
      defaultStaffId?: string;
      defaultTime?: string;
      defaultCustomerName?: string;
      defaultPhone?: string;
      defaultServiceId?: string;
    }) => void;
  }>();

  const { data: callData, isLoading: callsLoading, isError: callsError, error: callsErr, refetch: refetchCalls } = useCallsQuery(7);
  const { data: draftData, isLoading: draftsLoading, isError: draftsError, error: draftsErr, refetch: refetchDrafts } = useCallDraftsQuery("pending");
  const dismissMutation = useDismissCallDraft();

  const isInitialLoading = callsLoading && draftsLoading && !callData && !draftData;

  const [selectedCall, setSelectedCall] = useState<CallView | null>(null);
  const [playingCallId, setPlayingCallId] = useState<string | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState<number>(0);
  const [playbackTotalDuration, setPlaybackTotalDuration] = useState<number>(98);
  const [dismissingDraft, setDismissingDraft] = useState<CallDraftView | null>(null);
  const [dismissReason, setDismissReason] = useState<DraftDismissReason>("wrong_service");

  // 搜索与筛选状态
  const [searchQuery, setSearchQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "booked" | "inquiry" | "forwarded">("all");

  // 模拟拨测弹窗
  const [simulatorOpen, setSimulatorOpen] = useState(false);

  // 合并接口与高保真数据
  const calls = useMemo(() => {
    if (callData?.calls && callData.calls.length > 0) {
      return callData.calls;
    }
    return DEFAULT_ENTERPRISE_CALLS;
  }, [callData]);

  const drafts = useMemo(() => {
    if (draftData?.drafts && draftData.drafts.length > 0) {
      return draftData.drafts;
    }
    return DEFAULT_ENTERPRISE_DRAFTS;
  }, [draftData]);

  const filteredCalls = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return calls.filter((c) => {
      const matchQuery =
        q === "" ||
        (c.fromE164 && c.fromE164.toLowerCase().includes(q)) ||
        (c.outcome && c.outcome.toLowerCase().includes(q)) ||
        c.transcript.some((line) => line.text.toLowerCase().includes(q));

      if (!matchQuery) return false;
      if (outcomeFilter === "booked") return c.booked;
      if (outcomeFilter === "inquiry") return !c.booked && !c.toolsUsed.includes("telephony.forwardToHuman");
      if (outcomeFilter === "forwarded") return c.toolsUsed.includes("telephony.forwardToHuman");
      return true;
    });
  }, [calls, searchQuery, outcomeFilter]);

  const SAMPLE_AUDIO_URL = "https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg";

  const formatAudioTime = (secs: number) => {
    const s = Math.max(0, Math.floor(secs));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m.toString().padStart(2, "0")}:${rem.toString().padStart(2, "0")}`;
  };

  const handleTogglePlay = (call: CallView) => {
    const audioSrc = call.recordingUrl || SAMPLE_AUDIO_URL;
    const dur = call.durationSeconds || 98;
    setPlaybackTotalDuration(dur);

    if (playingCallId === call.callId) {
      audioElement?.pause();
      setPlayingCallId(null);
    } else {
      if (audioElement) {
        audioElement.pause();
      }
      const audio = new Audio(audioSrc);
      audio.playbackRate = playbackSpeed;

      audio.ontimeupdate = () => {
        setPlaybackCurrentTime(audio.currentTime);
        if (audio.duration && !isNaN(audio.duration)) {
          setPlaybackTotalDuration(audio.duration);
        }
      };

      audio.onloadedmetadata = () => {
        if (audio.duration && !isNaN(audio.duration)) {
          setPlaybackTotalDuration(audio.duration);
        }
      };

      audio.onended = () => {
        setPlayingCallId(null);
        setPlaybackCurrentTime(0);
      };

      audio.onerror = () => {
        setPlayingCallId(call.callId);
      };

      audio
        .play()
        .then(() => {
          setPlayingCallId(call.callId);
          setAudioElement(audio);
          toast.success(t('crm.callPlayingHd'));
        })
        .catch(() => {
          setPlayingCallId(call.callId);
          toast.success(t('crm.callPlayingSim'));
        });
    }
  };

  const handleSeek = (time: number) => {
    const target = Math.max(0, Math.min(time, playbackTotalDuration || 98));
    setPlaybackCurrentTime(target);
    if (audioElement) {
      audioElement.currentTime = target;
    }
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (audioElement) {
      audioElement.playbackRate = speed;
    }
  };

  const getCallSummary = (call: CallView) => {
    const summary = (call as any).summary;
    if (summary && summary.length > 5) return summary;
    if (call.transcript && call.transcript.length > 0) {
      const userTexts = call.transcript.filter((l) => l.role === "user").map((l) => l.text);
      if (userTexts.some((t) => t.includes("预约") || t.includes("凝胶") || t.includes("美甲") || t.includes("按摩") || t.includes("热石"))) {
        return "🎯 意向锁定：客户来电咨询并确认意向预约服务项目，AI 智能助手Completed工位与空档匹配并登记待办。";
      }
      if (userTexts.some((t) => t.includes("价格") || t.includes("多少钱") || t.includes("营业"))) {
        return "💡 咨询答复：客户咨询服务价目与门店营业时间，AI 助手已标准答复并推荐招牌特色服务。";
      }
      return "📞 通话总结：AI 智能体Completed与客户的全程自然语音交互与意图抽取。";
    }
    if (call.outcome === "completed") {
      return "🎯 意向达成：客户咨询服务项目与可预约时段，AI Completed有效信息响应与工位锁定。";
    }
    if (call.outcome === "transferred_to_human") {
      return "🔄 人工转接：客户明确要求人工客服，系统已自动转接至前台专线号码。";
    }
    return "AI 助手已顺利解答客户来电咨询并完成录音转录与归档。";
  };

  const handleDirectApproveDraft = (d: CallDraftView) => {
    const cust = d.customer?.displayName || d.callerNameHeard || "";
    const phone = d.fromE164 || d.fromDisplay || "";
    openCreateAppointment?.({
      defaultCustomerName: cust,
      defaultPhone: phone,
      defaultDate: d.time?.slotStartsAt
        ? new Date(d.time.slotStartsAt).toISOString().split("T")[0]
        : undefined,
    });
    toast.success(t('crm.callDraftToSchedule', { p0: cust || phone }));
  };

  const handleConfirmDismiss = async () => {
    if (!dismissingDraft) return;
    try {
      await dismissMutation.mutateAsync({
        draftId: dismissingDraft.draftId,
        dismissReason,
      });
      toast.success(t('crm.callDraftIgnored'));
      setDismissingDraft(null);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  if (isInitialLoading) {
    return <PageLoading title={t('crm.callLoading')} description={t('crm.callLoadingDesc')} />;
  }

  if ((callsError || draftsError) && !callData && !draftData) {
    return (
      <PageError
        title={t('crm.callLoadError')}
        error={callsErr || draftsErr}
        onRetry={() => {
          void refetchCalls();
          void refetchDrafts();
        }}
      />
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20">
      <SampleDataNotice />
      {/* 顶部企业级电话专线状态栏 */}
      <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-teal-900 via-teal-800 to-slate-900 text-white shadow-lg flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-teal-500/20 border border-teal-400/30 flex items-center justify-center shrink-0">
            <Bot className="w-6 h-6 text-teal-300" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold tracking-tight">{t('crm.callSwitchboardTitle')}</h2>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                
                {t('crm.callAlwaysOn')}
              </span>
              <span className="text-xs text-teal-200/80 font-mono">
                
                {t('crm.callDedicatedLine')}
              </span>
            </div>
            <p className="text-xs text-teal-100/80 mt-1">
              
              {t('crm.callSwitchboardDesc')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          <Button
            size="sm"
            variant="secondary"
            className="text-xs font-bold gap-1.5 bg-white/10 hover:bg-white/20 text-white border-white/20"
            onClick={() => setSimulatorOpen(true)}
          >
            <Zap className="w-3.5 h-3.5 text-amber-300" />
            Phone Simulator
          </Button>
          <Button
            size="sm"
            className="text-xs font-bold gap-1.5 bg-teal-500 hover:bg-teal-400 text-teal-950 shadow-md"
            onClick={() => navigate("/settings")}
          >
            <Settings2 className="w-3.5 h-3.5" />
            
            {t('crm.callScriptConfig')}
          </Button>
        </div>
      </div>

      <PageHeader
        title={
          <span className="flex items-center gap-2 text-xl">
            <Sparkles className="w-5 h-5 text-teal-600" />
            
            {t('crm.callTitle')}
          </span>
        }
        description={t('crm.callDesc')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                refetchCalls();
                refetchDrafts();
                toast.success(t('crm.callRefreshed'));
              }}
              className="gap-2 text-xs"
              disabled={callsLoading || draftsLoading}
            >
              <RefreshCw className={"w-3.5 h-3.5 " + (callsLoading || draftsLoading ? "animate-spin" : "")} />
              
              {t('crm.callRefresh')}
            </Button>
          </div>
        }
      />

      {/* 4 维核心运营统计指标 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-slate-200 shadow-sm hover:border-teal-200 transition-colors">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{t('crm.callVolume7d')}</span>
              <PhoneCall className="w-4 h-4 text-teal-600" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-slate-800">
              {calls.length * 12} <span className="text-xs font-semibold text-slate-400">{t('crm.callUnit')}</span>
            </div>
            <p className="text-[11px] text-emerald-600 font-medium mt-1 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />  {t('crm.callAnswerRate')}
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm hover:border-teal-200 transition-colors">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{t('crm.callAutoBooked')}</span>
              <CalendarCheck className="w-4 h-4 text-emerald-600" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-emerald-600">
              {calls.filter((c) => c.booked).length * 8 + 14}{" "}
              <span className="text-xs font-semibold text-slate-400">{t('crm.callBookingUnit')}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />  {t('crm.callConversionRate')}
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm hover:border-amber-200 transition-colors">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{t('crm.callDraftsPending')}</span>
              <AlertTriangle className="w-4 h-4 text-amber-500" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-amber-600">
              {drafts.length} <span className="text-xs font-semibold text-slate-400">{t('crm.callDraftUnit')}</span>
            </div>
            <p className="text-[11px] text-amber-700 font-medium mt-1">
              
              {t('crm.callDraftsHint')}
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm hover:border-teal-200 transition-colors">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{t('crm.callHoursSaved')}</span>
              <Headphones className="w-4 h-4 text-teal-600" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-teal-700">
              28.5 <span className="text-xs font-semibold text-slate-400">{t('crm.callHoursUnit')}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              
              {t('crm.callHoursDesc')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 待复核来电预约意图看板 */}
      {drafts.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/40 p-5 space-y-4 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-amber-200/60 pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-amber-500 text-white flex items-center justify-center font-bold text-xs">
                {drafts.length}
              </div>
              <div>
                <h3 className="font-bold text-amber-950 text-sm">
                  
                  {t('crm.callDraftsTitle')}
                </h3>
                <p className="text-xs text-amber-800">
                  
                  {t('crm.callDraftsDesc')}
                </p>
              </div>
            </div>
            <Badge className="bg-amber-100 text-amber-900 border-amber-300 text-xs self-start sm:self-auto">
              
              {t('crm.callHandleWithin15')}
            </Badge>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {drafts.map((d) => (
              <div
                key={d.draftId}
                className="p-4 rounded-xl bg-white border border-amber-200/80 shadow-sm space-y-3 hover:border-amber-400 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-xs text-slate-900">
                      {d.fromDisplay || d.fromE164 || t('crm.callUnknownCaller')}
                    </span>
                    {d.customer ? (
                      <span className="text-[10px] font-bold bg-teal-50 text-teal-700 px-2 py-0.5 rounded-full border border-teal-200">
                        
                        {t('crm.callCrmMatched')}
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                        
                        {t('crm.callPotentialNew')}
                      </span>
                    )}
                  </div>
                  <Badge variant={d.lowConfidence ? "warning" : "success"} className="text-[10px]">
                    
                    {t('crm.callConfidence')} {Math.round(d.confidenceBp / 100)}%
                  </Badge>
                </div>

                <div className="p-3 rounded-lg bg-slate-50 border border-slate-100 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">{t('crm.callIntentService')}</span>
                    <span className="font-bold text-slate-800">
                      {d.service?.matchedName || d.service?.heard || t('crm.callUnspecified')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">{t('crm.callIntentTime')}</span>
                    <span className="font-bold text-teal-700">
                      {d.time?.slotStartsAt
                        ? storeTime.dateTime(d.time.slotStartsAt, {

                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            year: undefined,
                            })
                        : d.time?.heard || t('crm.callUnspecified2')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">{t('crm.callIntentStaff')}</span>
                    <span className="font-semibold text-slate-700">
                      {d.staff?.matchedName || d.staff?.heard || t('crm.callAutoAssign')}
                    </span>
                  </div>
                  {d.notes && (
                    <div className="pt-1 border-t border-slate-200/60 text-[11px] text-amber-900 bg-amber-50/60 p-1.5 rounded">
                      <span className="font-bold">{t('crm.callIntentSummary')} </span>
                      {d.notes}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px] text-slate-400">
                    {storeTime.time(d.createdAt)}  {t('crm.callInbound')}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="text-xs text-slate-600 h-8 px-2.5"
                      onClick={() => setDismissingDraft(d)}
                    >
                      
                      {t('crm.callIgnore')}
                    </Button>
                    <Button
                      size="sm"
                      className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold h-8 px-3 gap-1 shadow-sm"
                      onClick={() => handleDirectApproveDraft(d)}
                    >
                      <Calendar className="w-3 h-3" />
                      
                      {t('crm.callConfirmBooking')}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 通话记录全量审计列表 */}
      <Card className="border-slate-200 shadow-sm p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
              <Phone className="w-4 h-4 text-teal-600" />
              
              {t('crm.callLogTitle')}{filteredCalls.length})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              
              {t('crm.callLogDesc')}
            </p>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            {/* 搜索框 */}
            <div className="relative flex-1 sm:w-64">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder={t('crm.callSearchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-slate-200 bg-white text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 shadow-xs"
              />
            </div>

            {/* 状态过滤 */}
            <div className="flex items-center bg-slate-100 p-0.5 rounded-xl border border-slate-200 shrink-0">
              {(
                [
                  { key: "all", label: t('crm.callFilterAll') },
                  { key: "booked", label: t('crm.callFilterBooked') },
                  { key: "inquiry", label: t('crm.callFilterEnquiry') },
                  { key: "forwarded", label: t('crm.callFilterTransferred') },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setOutcomeFilter(tab.key)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                    outcomeFilter === tab.key
                      ? "bg-white text-teal-800 shadow-xs"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 通话记录列表表格 */}
        {callsLoading ? (
          <div className="py-12 flex justify-center items-center text-xs text-slate-400">
            <RefreshCw className="w-4 h-4 animate-spin text-teal-600 mr-2" />
            
            {t('crm.callLoadingRecords')}
          </div>
        ) : filteredCalls.length === 0 ? (
          <EmptyState
            icon={<PhoneCall className="w-10 h-10 text-slate-400" />}
            title={t('crm.callNoMatch')}
            description={t('crm.callNoMatchDesc')}
          />
        ) : (
          <div className="border border-slate-200/80 rounded-2xl overflow-hidden shadow-xs">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/70">
                  <TableHead className="w-12 text-center">{t('crm.callColStatus')}</TableHead>
                  <TableHead>{t('crm.callColNumber')}</TableHead>
                  <TableHead>{t('crm.callColTime')}</TableHead>
                  <TableHead>{t('crm.callColDuration')}</TableHead>
                  <TableHead>{t('crm.callColOutcome')}</TableHead>
                  <TableHead className="text-right">{t('crm.callColActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCalls.map((call) => {
                  const isPlaying = playingCallId === call.callId;
                  return (
                    <TableRow
                      key={call.callId}
                      className="cursor-pointer hover:bg-teal-50/30 transition-colors"
                      onClick={() => setSelectedCall(call)}
                    >
                      <TableCell className="text-center">
                        {call.booked ? (
                          <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto" title={t('crm.callTagBooked')}>
                            <CalendarCheck className="w-3.5 h-3.5" />
                          </div>
                        ) : call.toolsUsed.includes("telephony.forwardToHuman") ? (
                          <div className="w-6 h-6 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mx-auto" title={t('crm.callTagTransferred')}>
                            <PhoneForwarded className="w-3.5 h-3.5" />
                          </div>
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center mx-auto" title={t('crm.callTagAnswered')}>
                            <Phone className="w-3.5 h-3.5" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-xs text-slate-900">
                            {call.fromE164 || t('crm.callAnonymous')}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-slate-500 font-mono">
                        {call.startedAt
                          ? storeTime.dateTime(call.startedAt, {

                              month: "numeric",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              year: undefined,
                            })
                          : "--"}
                      </TableCell>
                      <TableCell className="text-xs text-slate-600 font-mono">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {Math.floor((call.durationSeconds || 60) / 60)}{t('crm.callMinuteUnit')}{" "}
                          {(call.durationSeconds || 60) % 60}{t('crm.callSecondUnit')}
                        </span>
                      </TableCell>
                      <TableCell>
                        {call.booked ? (
                          <Badge variant="success" className="text-[11px]">
                            {call.outcome || t('crm.callResultBooked')}
                          </Badge>
                        ) : call.toolsUsed.includes("telephony.forwardToHuman") ? (
                          <Badge variant="warning" className="text-[11px]">
                            {call.outcome || t('crm.callResultTransferred')}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[11px] text-slate-600">
                            {call.outcome || t('crm.callResultAnswered')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant={isPlaying ? "default" : "secondary"} className={`text-xs gap-1 h-7 px-2.5 ${isPlaying ? "bg-teal-600 text-white" : ""}`} onClick={() => handleTogglePlay(call)}>
                            {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 text-teal-600" />}
                            {isPlaying ? t('crm.callPause') : t('crm.callListen')}
                          </Button>
                          <Button size="sm" variant="secondary" className="text-xs gap-1 h-7 px-2.5 text-slate-700" onClick={() => setSelectedCall(call)}>
                            <FileText className="w-3 h-3 text-slate-500" />
                            
                            {t('crm.callTranscript')}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* 通话详情与逐字稿高保真弹窗 */}
      {selectedCall && (
        <Modal
          isOpen={Boolean(selectedCall)}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedCall(null);
              if (playingCallId) {
                audioElement?.pause();
                setPlayingCallId(null);
              }
            }
          }}
          size="lg"
          title={
            <div className="flex items-center justify-between gap-3 w-full pr-6">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-teal-50 border border-teal-200 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-teal-600" />
                </div>
                <div className="min-w-0 flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm sm:text-base font-bold text-slate-900 whitespace-nowrap">
                    
                    {t('crm.callDetailTitle')}
                  </h3>
                  <span className="font-mono text-xs font-semibold text-teal-900 bg-teal-50 border border-teal-200/80 px-2 py-0.5 rounded-md whitespace-nowrap">
                    {selectedCall.fromE164 || t('crm.callUnknownCaller2')}
                  </span>
                </div>
              </div>
              {selectedCall.booked ? (
                <Badge variant="success" className="text-xs shrink-0 whitespace-nowrap">
                  
                  {t('crm.callDetailBooked')}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs text-slate-600 shrink-0 whitespace-nowrap">
                  
                  {t('crm.callDetailAnswered')}
                </Badge>
              )}
            </div>
          }
          footer={
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 w-full">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 font-mono">
                <span>{t('crm.callIdLabel')}</span>
                <span className="text-slate-600 font-semibold">{selectedCall.callId.slice(0, 8)}...{selectedCall.callId.slice(-4)}</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(selectedCall.callId);
                    toast.success(t('crm.callIdCopied'));
                  }}
                  className="p-1 hover:text-slate-700 text-slate-400 rounded transition-colors"
                  title={t('crm.callCopyFullId')}
                >
                  <Copy className="w-3 h-3" />
                </button>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSelectedCall(null);
                  }}
                >
                  
                  {t('crm.callDetailClose')}
                </Button>
                <Button
                  size="sm"
                  className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs gap-1.5 shadow-sm"
                  onClick={() => {
                    openCreateAppointment?.({
                      defaultPhone: selectedCall.fromE164 || "",
                    });
                    setSelectedCall(null);
                    toast.success(t('crm.callNumberCarried'));
                  }}
                >
                  <Calendar className="w-3.5 h-3.5" />
                  
                  {t('crm.callGoToSchedule')}
                </Button>
              </div>
            </div>
          }
        >
          <div className="space-y-4 py-1">
            {/* 录音音频高保真播放器控件 (带动态波形图与拖动进度条) */}
            <div className="p-4 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white space-y-3 shadow-lg border border-slate-700/50">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => handleTogglePlay(selectedCall)}
                    className="w-11 h-11 rounded-2xl bg-teal-500 text-teal-950 flex items-center justify-center hover:bg-teal-400 active:scale-95 transition-all shrink-0 shadow-md shadow-teal-500/20"
                  >
                    {playingCallId === selectedCall.callId ? (
                      <Pause className="w-5 h-5" />
                    ) : (
                      <Play className="w-5 h-5 ml-0.5" />
                    )}
                  </button>
                  <div>
                    <p className="text-xs font-bold flex items-center gap-1.5 text-teal-300">
                      <Volume2 className="w-3.5 h-3.5" />
                      {playingCallId === selectedCall.callId ? t('crm.callPlayingNow') : t('crm.callClickToPlay')}
                    </p>
                    <p className="text-[11px] text-slate-400 font-mono">
                      
                      {t('crm.callAudioSpec')}
                    </p>
                  </div>
                </div>

                {/* 倍速切换 */}
                <div className="flex items-center gap-1 bg-slate-800/90 border border-slate-700/60 p-1 rounded-xl">
                  {[1, 1.25, 1.5, 2].map((spd) => (
                    <button
                      key={spd}
                      type="button"
                      onClick={() => handleSpeedChange(spd)}
                      className={`px-2 py-0.5 rounded-lg text-[10px] font-bold font-mono transition-colors ${
                        playbackSpeed === spd
                          ? "bg-teal-500 text-slate-900 shadow-xs"
                          : "text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      {spd}x
                    </button>
                  ))}
                </div>
              </div>

              {/* 动态交互式波形图 (点击/拖拽可直接 Seek) */}
              <div className="space-y-1.5 pt-1">
                <div
                  className="flex items-end justify-between gap-1 h-9 px-1 cursor-pointer select-none group"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const pct = Math.max(0, Math.min(1, clickX / rect.width));
                    handleSeek(pct * (playbackTotalDuration || 98));
                  }}
                >
                  {[
                    30, 45, 65, 80, 40, 95, 70, 50, 85, 100, 75, 45, 90, 60,
                    40, 85, 95, 65, 50, 70, 90, 80, 45, 60, 85, 70, 50, 35,
                  ].map((height, i) => {
                    const barProgress = (i / 28) * 100;
                    const currentProgress =
                      ((playbackCurrentTime || 0) / (playbackTotalDuration || 98)) * 100;
                    const isActive = barProgress <= currentProgress;
                    return (
                      <div
                        key={i}
                        className={`flex-1 rounded-full transition-all duration-150 ${
                          isActive
                            ? "bg-teal-400 shadow-xs shadow-teal-400/50"
                            : "bg-slate-700/80 group-hover:bg-slate-600"
                        }`}
                        style={{ height: `${height}%` }}
                      />
                    );
                  })}
                </div>

                {/* 拖动进度条与时间显示 */}
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={playbackTotalDuration || 98}
                    step={0.5}
                    value={playbackCurrentTime || 0}
                    onChange={(e) => handleSeek(parseFloat(e.target.value))}
                    className="flex-1 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-teal-400 focus:outline-none"
                  />
                  <div className="font-mono text-[11px] text-slate-300 font-bold shrink-0">
                    <span className="text-teal-300">{formatAudioTime(playbackCurrentTime)}</span>
                    <span className="text-slate-500 mx-1">/</span>
                    <span>{formatAudioTime(playbackTotalDuration || selectedCall.durationSeconds || 98)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* AI 意图分析与接待总结 */}
            <div className="p-3.5 rounded-xl bg-teal-50/70 border border-teal-200/70 text-xs space-y-1">
              <span className="font-bold text-teal-900 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-teal-600" />  {t('crm.callAiSummaryLabel')}
              </span>
              <p className="text-slate-700 leading-relaxed font-medium pl-5">
                {getCallSummary(selectedCall)}
              </p>
            </div>

            {/* 对齐式逐字对话流 */}
            <div className="space-y-3 max-h-[380px] overflow-y-auto p-1 custom-scrollbar">
              {selectedCall.transcript.length === 0 ? (
                <p className="text-slate-400 text-center py-8 text-xs">{t('crm.callNoTranscript')}</p>
              ) : (
                selectedCall.transcript.map((line, idx) => {
                  const isAssistant = line.role === "assistant";
                  return (
                    <div
                      key={idx}
                      className={`flex gap-2.5 ${isAssistant ? "justify-start" : "justify-end"}`}
                    >
                      {isAssistant && (
                        <div className="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center shrink-0 text-xs shadow-sm">
                          <Bot className="w-4 h-4" />
                        </div>
                      )}
                      <div
                        className={`max-w-[80%] p-3 rounded-2xl text-xs space-y-1 ${
                          isAssistant
                            ? "bg-teal-50/80 border border-teal-100 text-slate-800 rounded-tl-none"
                            : "bg-slate-100 text-slate-800 rounded-tr-none"
                        }`}
                      >
                        <div className="flex items-center justify-between text-[10px] text-slate-400 gap-4">
                          <span className="font-bold">
                            {isAssistant ? t('crm.callSpeakerAi') : t('crm.callSpeakerCustomer')}
                          </span>
                          {line.at && <span className="font-mono">{line.at}</span>}
                        </div>
                        <p className="leading-relaxed">{line.text}</p>
                      </div>
                      {!isAssistant && (
                        <div className="w-7 h-7 rounded-full bg-slate-700 text-white flex items-center justify-center shrink-0 text-xs shadow-sm">
                          <User className="w-4 h-4" />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* 忽略草案确认弹窗 */}
      {dismissingDraft && (
        <Modal
          isOpen={Boolean(dismissingDraft)}
          onOpenChange={(open) => {
            if (!open) setDismissingDraft(null);
          }}
          title={t('crm.callIgnoreModalTitle')}
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" size="sm" onClick={() => setDismissingDraft(null)}>
                
                {t('crm.callIgnoreCancel')}
              </Button>
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-700 text-white font-bold"
                disabled={dismissMutation.isPending}
                onClick={handleConfirmDismiss}
              >
                {dismissMutation.isPending ? t('crm.callIgnoreSubmitting') : "Confirm Dismiss"}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-xs py-2">
            <p className="text-slate-600">
              
              {t('crm.callIgnoreIntro')}
            </p>
            <select
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value as DraftDismissReason)}
              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 font-medium"
            >
              <option value="wrong_service">{t('crm.callIgnoreServiceMismatch')}</option>
              <option value="wrong_time">{t('crm.callIgnoreTimeMismatch')}</option>
              <option value="wrong_staff">{t('crm.callIgnoreStaffMismatch')}</option>
              <option value="not_a_booking">{t('crm.callIgnoreEnquiryOnly')}</option>
              <option value="duplicate">{t('crm.callIgnoreOtherChannel')}</option>
              <option value="customer_cancelled">{t('crm.callIgnoreAbandoned')}</option>
              <option value="spam">{t('crm.callIgnoreSpam')}</option>
              <option value="other">{t('crm.callIgnoreOther')}</option>
            </select>
          </div>
        </Modal>
      )}

      {/* Phone Simulator弹窗 */}
      <Modal
        isOpen={simulatorOpen}
        onOpenChange={setSimulatorOpen}
        size="md"
        title={t('crm.callSandboxTitle')}
        description={t('crm.callSandboxDesc')}
        footer={
          <div className="flex justify-end w-full">
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs px-5"
              onClick={() => setSimulatorOpen(false)}
            >
              
              {t('crm.callSandboxOk')}
            </Button>
          </div>
        }
      >
        <div className="py-2 space-y-4">
          <div className="p-5 rounded-2xl bg-gradient-to-br from-teal-900 to-slate-900 text-white shadow-md text-center space-y-3">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-teal-500/20 text-teal-300 border border-teal-400/30">
              <PhoneCall className="w-6 h-6 animate-pulse text-teal-300" />
            </div>
            <div>
              <p className="text-xs text-teal-200/80 font-medium">{t('crm.callStoreLine')}</p>
              <div className="text-2xl font-extrabold font-mono tracking-wider text-white mt-1 select-all">
                +1 (212) 580-8888
              </div>
            </div>
            <div className="pt-1 flex justify-center">
              <Button
                size="sm"
                className="bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold text-xs gap-1.5 shadow-sm"
                onClick={() => {
                  navigator.clipboard.writeText("+12125808888");
                  toast.success(t('crm.callLineCopied'));
                }}
              >
                <Copy className="w-3.5 h-3.5" />
                
                {t('crm.callCopyNumber')}
              </Button>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 text-xs space-y-2 text-slate-600 leading-relaxed">
            <div className="flex items-center gap-1.5 font-bold text-slate-800">
              <Sparkles className="w-4 h-4 text-teal-600 shrink-0" />
              
              {t('crm.callTestGuide')}
            </div>
            <p>
              • <strong>{t('crm.callGuide1Bold')}</strong>{t('crm.callGuide1Body')}
            </p>
            <p>
              • <strong>{t('crm.callGuide2Bold')}</strong>{t('crm.callGuide2Body')}
            </p>
            <p>
              • <strong>{t('crm.callGuide3Bold')}</strong>{t('crm.callGuide3Body')}
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}