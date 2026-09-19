import { apiGet } from '@/lib/api';
import { useState, useMemo } from "react";
import { useErrorMessage } from '@/lib/errorMessage';
import { useStoreTime, instantToWallDate } from '@/lib/time';
import { useLanguage } from "@/LanguageContext";
import { formatPhoneDisplay } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
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
import { callDeskMetrics } from "@/features/comms/callMetrics";
import { useNavigate, useOutletContext } from "react-router-dom";

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

  const calls = callData?.calls ?? [];
  const drafts = draftData?.drafts ?? [];
  const metrics = callDeskMetrics({
    calls,
    bookedCount: callData?.bookedCount ?? 0,
    totalMinutes: callData?.totalMinutes ?? 0,
  });

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

  const formatAudioTime = (secs: number) => {
    const s = Math.max(0, Math.floor(secs));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m.toString().padStart(2, "0")}:${rem.toString().padStart(2, "0")}`;
  };

  const handleTogglePlay = async (call: CallView) => {
    if (!call.recordingUrl && !call.recordingId) {
      toast.danger(t('crm.callNoRecording'));
      return;
    }
    let audioSrc = call.recordingUrl;
    if (call.recordingId) {
      try { audioSrc = (await apiGet<{ url: string }>(`/v1/desk/calls/${call.callId}/recording`)).url; }
      catch { toast.danger(t('crm.callNoRecording')); return; }
    }
    if (!audioSrc) return;
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

  /**
   * ⚠️ `CallView` 没有 `summary` 字段（见 features/comms/types.ts）——
   * 后端目前不产出真正的 AI 通话总结。这里以前在缺失时会用转写文本
   * 关键词匹配（"预约"/"价格"…）拼出一句看起来像模型判断的固定文案，
   * 顶着「AI 意图分析与接待总结」的标题和 Sparkles 图标展示。
   *
   * 那不是分析结果，只是字符串包含检测：转写里出现"预约"两个字，
   * 不代表任何工位真的被匹配、任何待办真的被登记 —— 而文案正是这么说的。
   * 把猜测的结果包装成 AI 判断展示给老板，比"暂无总结"更容易造成误判。
   * 空就是空，直到后端真的提供这个字段。
   */
  const getCallSummary = (call: CallView): string | null => {
    const summary = (call as { summary?: string }).summary;
    return summary && summary.length > 5 ? summary : null;
  };

  const handleDirectApproveDraft = (d: CallDraftView) => {
    const cust = d.customer?.displayName || d.callerNameHeard || "";
    const phone = d.fromE164 || d.fromDisplay || "";
    openCreateAppointment?.({
      defaultCustomerName: cust,
      defaultPhone: phone,
      // 门店墙上日期，不是 UTC 日期：洛杉矶晚 8 点的槽位 toISOString() 会落到次日
      defaultDate: d.time?.slotStartsAt
        ? instantToWallDate(d.time.slotStartsAt, storeTime.timeZone)
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
    return <PageLoading layout="table" title={t('crm.callLoading')} description={t('crm.callLoadingDesc')} />;
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
            {t('crm.callSimulator')}
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
              {metrics.inboundCount} <span className="text-xs font-semibold text-slate-400">{t('crm.callUnit')}</span>
            </div>
            <p className="text-[11px] text-slate-500 font-medium mt-1 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              {metrics.inboundCount === 0 ? t('crm.callNoInbound') : t('crm.callVolume7d')}
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
              {metrics.bookedCount}{" "}
              <span className="text-xs font-semibold text-slate-400">{t('crm.callBookingUnit')}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
              {t('crm.callConversionRate', { p0: metrics.conversionPercent })}
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
              {metrics.hoursSaved} <span className="text-xs font-semibold text-slate-400">{t('crm.callHoursUnit')}</span>
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
                      {d.fromDisplay ? formatPhoneDisplay(d.fromDisplay) : d.fromE164 ? formatPhoneDisplay(d.fromE164) : t('crm.callUnknownCaller')}
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
                            {call.fromE164 ? formatPhoneDisplay(call.fromE164) : t('crm.callAnonymous')}
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
                          {Math.floor((call.durationSeconds ?? 0) / 60)}{t('crm.callMinuteUnit')}{" "}
                          {(call.durationSeconds ?? 0) % 60}{t('crm.callSecondUnit')}
                        </span>
                        {call.billingStatus && call.billingStatus !== 'legacy' && <p className="text-[10px] text-slate-500 mt-1">
                          {call.billingStatus === 'settled'
                            ? t('crm.callBilledMinutes', { p0: Math.ceil((call.billableSeconds ?? 0) / 60) })
                            : t(call.billingStatus === 'review' ? 'crm.callBillingReview' : 'crm.callBillingPending')}
                        </p>}
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
                    {selectedCall.fromE164 ? formatPhoneDisplay(selectedCall.fromE164) : t('crm.callUnknownCaller2')}
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
                      defaultPhone: selectedCall.fromE164 ? formatPhoneDisplay(selectedCall.fromE164) : "",
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
                {getCallSummary(selectedCall) ?? (
                  <span className="italic text-slate-400">{t('crm.callNoAiSummary')}</span>
                )}
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
                isPending={dismissMutation.isPending}
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
