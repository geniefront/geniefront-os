import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { DeliveryHistory } from '@/features/voice-plan/DeliveryHistory';
import { useEntitlements } from '@/features/billing/useEntitlements';
import { formatPhoneDisplay } from '@gf/contracts';
import { useMemo, useState } from "react";
import { useStoreTime } from '@/lib/time';
import { useLanguage } from "@/LanguageContext";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal, ConfirmDialog } from "@/components/ui/Modal";
import { PageLoading, PageError } from "@/components/ui/QueryState";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import {
  History,
  Search,
  Phone,
  MessageSquare,
  RefreshCw,
  Clock,
  CheckCircle2,
  FileCheck2,
  CalendarCheck,
  Download,
  AlertTriangle,
  FileText,
  Bot,
  Send,
  Sparkles,
  TrendingUp,
  ShieldCheck,
  Activity,
  Layers,
  PhoneForwarded,
} from "lucide-react";
import { toast } from "@heroui/react";
import { useCallsQuery, useInboundSmsQuery } from "@/features/comms/api";

export interface UnifiedCommLog {
  id: string;
  time: string;
  channel: "voice" | "sms_inbound" | "sms_outbound" | "system_reminder" | "health_intake";
  direction: "inbound" | "outbound" | "system";
  contact: string;
  customerName?: string;
  category: string;
  summary: string;
  status: "delivered" | "booked" | "opt_out" | "transferred" | "failed" | "completed";
  durationSeconds?: number;
  carrierSid?: string;
  rawPayload?: Record<string, any>;
}

export function CommunicationLogs() {
  const plan = useEntitlements(); const { t } = useLanguage();
  if (!plan.data) return <div className="p-6">{plan.isError ? t('genericFailure') : <LoadingSpinner />}</div>;
  return plan.data.plan === 'voice_booking' ? <DeliveryHistory /> : <FullCommunicationLogs />;
}
function FullCommunicationLogs() {
  const storeTime = useStoreTime();
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [channelFilter, setChannelFilter] = useState<
    "all" | "voice" | "sms" | "system" | "intake"
  >("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "booked" | "delivered" | "opt_out" | "transferred">("all");
  const [dateRange, setDateRange] = useState<"all" | "7d" | "30d">("7d");

  const [selectedLog, setSelectedLog] = useState<UnifiedCommLog | null>(null);

  const { data: callData, isLoading: callsLoading, isError: callsError, error: callsErr, refetch: refetchCalls } = useCallsQuery(30);
  const { data: smsData, isLoading: smsLoading, isError: smsError, error: smsErr, refetch: refetchSms } = useInboundSmsQuery(30);

  const isInitialLoading = callsLoading && smsLoading && !callData && !smsData;

  // 汇聚全渠道审计日志
  const unifiedLogs = useMemo<UnifiedCommLog[]>(() => {
    const list: UnifiedCommLog[] = [];

    if (callData?.calls && callData.calls.length > 0) {
      for (const c of callData.calls) {
        const isForwarded = c.toolsUsed?.includes("telephony.forwardToHuman");
        list.push({
          id: c.callId,
          time: c.startedAt || new Date().toISOString(),
          channel: "voice",
          direction: "inbound",
          contact: formatPhoneDisplay(c.fromE164) || t('crm.commUnknownCaller'),
          category: c.booked ? t('crm.commCategoryCallBooked') : isForwarded ? t('crm.commCategoryCallTransferred') : t('crm.commCategoryCallInquiry'),
          summary: c.outcome || (c.booked ? t('crm.commSummaryCallBooked') : t('crm.commSummaryGeneralInquiry')),
          status: c.booked ? "booked" : isForwarded ? "transferred" : "completed",
          durationSeconds: c.durationSeconds ?? undefined,
        });
      }
    }

    if (smsData?.messages && smsData.messages.length > 0) {
      for (const m of smsData.messages) {
        list.push({
          id: m.id,
          time: m.receivedAt,
          channel: "sms_inbound",
          direction: "inbound",
          contact: formatPhoneDisplay(m.fromE164),
          customerName: m.customers[0]?.name,
          category: m.intent === "opt_out" ? t('crm.commCategoryOptOut') : t('crm.commCategoryCustomerReply'),
          summary: m.body,
          status: m.intent === "opt_out" ? "opt_out" : "delivered",
        });
      }
    }

    return list.sort(
      (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
    );
  }, [callData, smsData]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return unifiedLogs.filter((l) => {
      // 渠道筛选
      if (channelFilter === "voice" && l.channel !== "voice") return false;
      if (channelFilter === "sms" && l.channel !== "sms_inbound" && l.channel !== "sms_outbound") return false;
      if (channelFilter === "system" && l.channel !== "system_reminder") return false;
      if (channelFilter === "intake" && l.channel !== "health_intake") return false;

      // 状态筛选
      if (statusFilter !== "all" && l.status !== statusFilter) return false;

      // 关键词搜索
      if (
        q !== "" &&
        !l.contact.toLowerCase().includes(q) &&
        !l.summary.toLowerCase().includes(q) &&
        !(l.customerName && l.customerName.toLowerCase().includes(q)) &&
        !l.category.toLowerCase().includes(q)
      ) {
        return false;
      }

      return true;
    });
  }, [unifiedLogs, query, channelFilter, statusFilter]);

  const voiceLogs = unifiedLogs.filter((log) => log.channel === 'voice');
  const selfResolvedRate = voiceLogs.length > 0
    ? Math.round((voiceLogs.filter((log) => log.status !== 'transferred').length / voiceLogs.length) * 1000) / 10
    : 0;

  const [confirmExportOpen, setConfirmExportOpen] = useState(false);

  const handleExportCsv = () => {
    const headers = `${t('crm.commExportHeaders')}\n`;
    const rows = filtered
      .map(
        (l) =>
          `"${storeTime.dateTime(l.time)}","${l.channel}","${l.direction}","${l.contact}","${
            l.customerName || "--"
          }","${l.category}","${l.summary.replace(/"/g, '""')}","${l.status}","${l.carrierSid || "--"}"`
      )
      .join("\n");
    const blob = new Blob(["\uFEFF" + headers + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `GenieFront_Comm_Audit_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t('crm.commExported'));
  };

  if (isInitialLoading) {
    return <PageLoading layout="table" title={t('crm.commLoading')} description={t('crm.commLoadingDesc')} />;
  }

  if ((callsError || smsError) && !callData && !smsData) {
    return (
      <PageError
        title={t('crm.commLoadError')}
        error={callsErr || smsErr}
        onRetry={() => {
          void refetchCalls();
          void refetchSms();
        }}
      />
    );
  }

  return (
    <div className="space-y-6 pb-20 max-w-7xl mx-auto">
      <PageHeader
        title={
          <span className="flex items-center gap-2 text-xl font-bold">
            <History className="w-5 h-5 text-teal-600" />
            
            {t('crm.commTitle')}
          </span>
        }
        description={t('crm.commDesc')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmExportOpen(true)}
              className="gap-1.5 text-xs font-bold"
            >
              <Download className="w-3.5 h-3.5 text-slate-600" />
              
              {t('crm.commExportCsv')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                refetchCalls();
                refetchSms();
                toast.success(t('crm.commRefreshed'));
              }}
              className="gap-2 text-xs"
              disabled={callsLoading || smsLoading}
            >
              <RefreshCw className={"w-3.5 h-3.5 " + (callsLoading || smsLoading ? "animate-spin" : "")} />
              {t("refresh") || t('crm.commRefresh')}
            </Button>
          </div>
        }
      />

      {/* 4 维指标概览 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{t('crm.commTotalTouches')}</span>
              <Activity className="w-4 h-4 text-teal-600" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-slate-800">
              {unifiedLogs.length} <span className="text-xs font-semibold text-slate-400">{t('crm.commTimes')}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{t('crm.commTouchesDesc')}</p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{t('crm.commAiClosureRate')}</span>
              <Bot className="w-4 h-4 text-teal-600" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-emerald-600">
              {selfResolvedRate}% <span className="text-xs font-semibold text-slate-400">{t('crm.commSelfResolved')}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{voiceLogs.length === 0 ? t('crm.commNoVoiceYet') : t('crm.commAiClosureDesc')}</p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{t('crm.commSmsDeliveryRate')}</span>
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-teal-700">
              — <span className="text-xs font-semibold text-slate-400">{t('crm.commDelivered')}</span>
            </div>
            <p className="text-[11px] text-emerald-600 font-medium mt-1">
              
              {t('crm.commSmsDesc')}
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{t('crm.commAvgResponse')}</span>
              <Clock className="w-4 h-4 text-teal-600" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-slate-800">
              — <span className="text-xs font-semibold text-slate-400">{t('crm.commMinutes')}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{t('crm.commResponseDesc')}</p>
          </CardContent>
        </Card>
      </div>

      {/* 审计日志数据卡片 */}
      <Card className="border-slate-200 shadow-sm p-4 sm:p-5 space-y-4">
        {/* 综合多维筛选条 */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          <div className="relative flex-1 w-full max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder={t('crm.commSearchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            />
          </div>

          <div className="flex items-center gap-2 flex-wrap w-full lg:w-auto">
            {/* 渠道切换 Pills */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl text-xs">
              {[
                { id: "all", label: t('crm.commChannelAll') },
                { id: "voice", label: t('crm.commChannelVoice'), icon: Phone },
                { id: "sms", label: t('crm.commChannelSms'), icon: MessageSquare },
                { id: "system", label: t('crm.commChannelSystem'), icon: Send },
                { id: "intake", label: t('crm.commChannelIntake'), icon: FileCheck2 },
              ].map((c) => (
                <button
                  key={c.id}
                  onClick={() => setChannelFilter(c.id as any)}
                  className={`px-2.5 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1 ${
                    channelFilter === c.id
                      ? "bg-white text-teal-900 font-bold shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {c.icon && <c.icon className="w-3 h-3" />}
                  <span>{c.label}</span>
                </button>
              ))}
            </div>

            {/* 状态下拉 */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 font-medium text-slate-700"
            >
              <option value="all">{t('crm.commStatusAll')}</option>
              <option value="booked">{t('crm.commStatusBooked')}</option>
              <option value="delivered">{t('crm.commStatusDelivered')}</option>
              <option value="transferred">{t('crm.commStatusTransferred')}</option>
              <option value="opt_out">{t('crm.commStatusOptedOut')}</option>
            </select>
          </div>
        </div>

        {/* 日志数据表格 */}
        {filtered.length === 0 ? (
          <EmptyState
            icon={<History className="w-10 h-10 text-slate-400" />}
            title={t('crm.commEmptyTitle')}
            description={t('crm.commEmptyDesc')}
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <Table>
              <TableHeader className="bg-slate-50/80">
                <TableRow>
                  <TableHead className="text-xs font-bold">{t('crm.commColTime')}</TableHead>
                  <TableHead className="text-xs font-bold">{t('crm.commColChannel')}</TableHead>
                  <TableHead className="text-xs font-bold">{t('crm.commColContact')}</TableHead>
                  <TableHead className="text-xs font-bold">{t('crm.commColCategory')}</TableHead>
                  <TableHead className="text-xs font-bold">{t('crm.commColSummary')}</TableHead>
                  <TableHead className="text-xs font-bold">{t('crm.commColStatus')}</TableHead>
                  <TableHead className="text-xs font-bold text-right">{t('crm.commColActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((log) => (
                  <TableRow
                    key={log.id}
                    className="hover:bg-teal-50/40 cursor-pointer transition-colors"
                    onClick={() => setSelectedLog(log)}
                  >
                    <TableCell className="text-xs text-slate-600 font-mono whitespace-nowrap">
                      {storeTime.dateTime(log.time, {

                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        year: undefined,
                            })}
                    </TableCell>

                    <TableCell>
                      {log.channel === "voice" ? (
                        <Badge variant="outline" className="gap-1 text-[11px] font-bold text-teal-800 bg-teal-50/70 border-teal-200">
                          <Phone className="w-3 h-3 text-teal-600" />  {t('crm.commRowVoice')}
                        </Badge>
                      ) : log.channel === "health_intake" ? (
                        <Badge variant="outline" className="gap-1 text-[11px] font-bold text-purple-800 bg-purple-50/70 border-purple-200">
                          <FileCheck2 className="w-3 h-3 text-purple-600" />  {t('crm.commRowIntake')}
                        </Badge>
                      ) : log.channel === "system_reminder" ? (
                        <Badge variant="outline" className="gap-1 text-[11px] text-blue-800 bg-blue-50/70 border-blue-200">
                          <Send className="w-3 h-3 text-blue-600" />  {t('crm.commRowAuto')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-[11px] text-slate-700 bg-slate-100">
                          <MessageSquare className="w-3 h-3 text-slate-500" />  {t('crm.commRowSms')}
                        </Badge>
                      )}
                    </TableCell>

                    <TableCell className="text-xs">
                      <div className="font-bold text-slate-900 font-mono">
                        {log.contact}
                      </div>
                      {log.customerName && (
                        <div className="text-[11px] text-slate-500">{log.customerName}</div>
                      )}
                    </TableCell>

                    <TableCell className="text-xs font-semibold text-slate-700">
                      {log.category}
                    </TableCell>

                    <TableCell className="text-xs text-slate-600 max-w-sm truncate leading-relaxed">
                      {log.summary}
                    </TableCell>

                    <TableCell>
                      <Badge
                        variant={
                          log.status === "booked"
                            ? "success"
                            : log.status === "opt_out"
                            ? "error"
                            : log.status === "transferred"
                            ? "warning"
                            : "default"
                        }
                        className="text-[11px] font-bold"
                      >
                        {log.status === "booked"
                          ? t('crm.commTagBooked')
                          : log.status === "opt_out"
                          ? t('crm.commTagOptedOut')
                          : log.status === "transferred"
                          ? t('crm.commTagTransferred')
                          : t('crm.commTagDelivered')}
                      </Badge>
                    </TableCell>

                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-xs h-7 px-2.5 text-slate-600"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedLog(log);
                        }}
                      >
                        
                        {t('crm.commAuditTrail')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* 审计日志详情弹窗 */}
      {selectedLog && (
        <Modal
          isOpen={Boolean(selectedLog)}
          onOpenChange={(open) => {
            if (!open) setSelectedLog(null);
          }}
          size="md"
          title={t('crm.commDetailTitle')}
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" size="sm" onClick={() => setSelectedLog(null)}>
                
                {t('crm.commClose')}
              </Button>
            </div>
          }
        >
          <div className="space-y-4 py-2 text-xs">
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 grid grid-cols-2 gap-3">
              <div>
                <span className="text-slate-400 block text-[11px]">{t('crm.commDetailTime')}</span>
                <span className="font-mono font-bold text-slate-800">
                  {storeTime.dateTime(selectedLog.time)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block text-[11px]">{t('crm.commDetailChannel')}</span>
                <span className="font-bold text-slate-800 capitalize">
                  {selectedLog.channel} ({selectedLog.direction})
                </span>
              </div>
              <div>
                <span className="text-slate-400 block text-[11px]">{t('crm.commDetailNumber')}</span>
                <span className="font-mono font-bold text-slate-800">{selectedLog.contact}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[11px]">{t('crm.commDetailProfile')}</span>
                <span className="font-bold text-teal-700">
                  {selectedLog.customerName || t('crm.commNoProfile')}
                </span>
              </div>
              <div className="col-span-2">
                <span className="text-slate-400 block text-[11px]">{t('crm.commDetailSid')}</span>
                <code className="text-slate-700 font-mono text-[11px] block break-all font-bold">
                  {selectedLog.carrierSid || "N/A"}
                </code>
              </div>
            </div>

            <div>
              <span className="font-bold text-slate-700 mb-1 block">{t('crm.commDetailBody')}</span>
              <div className="p-3 rounded-xl bg-white border border-slate-200 text-slate-800 leading-relaxed font-medium">
                {selectedLog.summary}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-teal-50 border border-teal-200 text-teal-950 space-y-1 text-[11px]">
              <span className="font-bold flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-teal-600" />
                
                {t('crm.commDetailCompliance')}
              </span>
              <p className="leading-relaxed">
                
                {t('crm.commComplianceBody')}
              </p>
            </div>
          </div>
        </Modal>
      )}

      {/* 导出 CSV 审计流水二次确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmExportOpen}
        onOpenChange={setConfirmExportOpen}
        title={t('crm.commExportConfirmTitle')}
        description={t('crm.commExportConfirmBody', { p0: filtered.length })}
        confirmLabel={t('crm.commExportConfirmAction')}
        onConfirm={handleExportCsv}
      />
    </div>
  );
}
