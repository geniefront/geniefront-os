import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "@heroui/react";
import { useLanguage } from "@/LanguageContext";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  Download,
  TrendingUp,
  Users,
  DollarSign,
  Award,
  Star,
  RefreshCw,
  Sparkles,
  Zap,
  Tag,
  CheckCircle2,
  AlertTriangle,
  Flame,
  UserCheck,
  BarChart3,
  ShieldAlert,
} from "lucide-react";
import { centsToDollars, toDisplayDollars } from "@/features/checkout/api";
import { useCan } from "@/lib/permissions";
import { useErrorMessage } from "@/lib/errorMessage";
import {
  useRevenueTrendsQuery,
  useCustomerRetentionQuery,
  useStaffAnalyticsQuery,
  useReviewsSummaryQuery,
  useHeatmapQuery,
  useRfmCustomersQuery,
  useTopServicesQuery,
  useCopilotSummaryQuery,
} from "@/features/analytics/api";
import { exportToCSV } from "@/lib/exportUtils";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PageLoading, PageError } from "@/components/ui/QueryState";

const PIE_COLORS = ["#0D9488", "#3B82F6", "#F59E0B", "#8B5CF6", "#EC4899", "#64748B"];
const CHANNEL_COLORS = ["#0D9488", "#0284C7", "#8B5CF6", "#F59E0B", "#10B981"];

const DAYS_OF_WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const HOURS_RANGE = ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00"];

export function BusinessData() {
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const canViewReport = useCan("report.view");
  const [exporting, setExporting] = useState(false);

  // 日期范围预设: "7d" | "30d" | "90d" | "thisMonth"
  const [rangePreset, setRangePreset] = useState<"7d" | "30d" | "90d" | "thisMonth">("30d");
  const [activeTab, setActiveTab] = useState<"revenue" | "customers" | "categories" | "staff" | "copilot">("revenue");

  const { from, to } = useMemo(() => {
    const today = new Date();
    const toStr = today.toISOString().slice(0, 10);
    const past = new Date(today);
    if (rangePreset === "7d") past.setDate(past.getDate() - 7);
    else if (rangePreset === "30d") past.setDate(past.getDate() - 30);
    else if (rangePreset === "90d") past.setDate(past.getDate() - 90);
    else {
      // 本月第一天
      past.setDate(1);
    }
    const fromStr = past.toISOString().slice(0, 10);
    return { from: fromStr, to: toStr };
  }, [rangePreset]);

  const revenueQ = useRevenueTrendsQuery(from, to, "day");
  const customersQ = useCustomerRetentionQuery(from, to);
  const staffQ = useStaffAnalyticsQuery(from, to);
  const reviewsQ = useReviewsSummaryQuery();
  const heatmapQ = useHeatmapQuery(from, to);
  const rfmQ = useRfmCustomersQuery(from, to);
  const topServicesQ = useTopServicesQuery(from, to);
  const copilotQ = useCopilotSummaryQuery();

  const isLoading = revenueQ.isLoading || customersQ.isLoading || staffQ.isLoading || heatmapQ.isLoading;
  const isInitialLoading = (revenueQ.isLoading || staffQ.isLoading) && !revenueQ.data && !revenueQ.error;

  const refetchAll = () => {
    void revenueQ.refetch();
    void customersQ.refetch();
    void staffQ.refetch();
    void reviewsQ.refetch();
    void heatmapQ.refetch();
    void rfmQ.refetch();
    void topServicesQ.refetch();
    void copilotQ.refetch();
  };

  // 格式化图表数据
  const chartData = useMemo(() => {
    const trends = revenueQ.data?.trends ?? [];
    return trends.map((pt) => ({
      name: pt.date.slice(5),
      services: toDisplayDollars(pt.serviceRevenueCents),
      retail: toDisplayDollars(pt.retailRevenueCents),
      giftCards: toDisplayDollars(pt.giftCardSalesCents),
      net: toDisplayDollars(pt.netCents),
      orders: Math.round(toDisplayDollars(pt.netCents) / 55) || 0,
    }));
  }, [revenueQ.data]);

  // 品类分布
  const categoryData = useMemo(() => {
    const list = revenueQ.data?.byCategory ?? [];
    return list.map((c) => ({
      name: c.name,
      value: toDisplayDollars(c.revenueCents),
      percent: (c.percentBp / 100).toFixed(1),
    }));
  }, [revenueQ.data]);

  const topServicesList = useMemo(() => {
    const list = topServicesQ.data?.services ?? [];
    return list.map((s) => ({
      rank: s.rank,
      name: s.name,
      category: s.categoryName,
      salesCount: s.salesCount,
      revenueCents: s.revenueCents,
      margin: `${s.marginPercent}%`,
      avgMins: s.avgDurationMinutes,
      rating: s.rating,
    }));
  }, [topServicesQ.data]);

  const copilotHighlights = copilotQ.data?.highlights ?? [];
  const copilotRisks = copilotQ.data?.risks ?? [];
  const copilotActions = copilotQ.data?.actions ?? [];
  const hasCopilotData = copilotHighlights.length > 0 || copilotRisks.length > 0 || copilotActions.length > 0;

  // 顾客来源渠道分布
  const channelData = useMemo(() => {
    const list = rfmQ.data?.channels ?? [];
    return list.map((c) => ({
      name: c.channelName,
      value: c.customerCount,
      percent: `${((c.percentBp || 0) / 100).toFixed(1)}%`,
    }));
  }, [rfmQ.data]);

  // 总销售额
  const totalNetRevenueDollars = useMemo(() => {
    const trends = revenueQ.data?.trends ?? [];
    if (trends.length > 0) {
      const sumCents = trends.reduce((acc, cur) => acc + cur.netCents, 0);
      return centsToDollars(sumCents);
    }
    return "0.00";
  }, [revenueQ.data]);

  // 403 / 权限门禁拦截
  const isForbidden =
    !canViewReport ||
    (revenueQ.isError && (revenueQ.error as any)?.status === 403) ||
    (customersQ.isError && (customersQ.error as any)?.status === 403);

  if (isForbidden) {
    return (
      <div className="max-w-4xl mx-auto w-full py-16 px-4">
        <Card className="border-slate-200 shadow-sm p-8 text-center bg-white">
          <EmptyState
            icon={<ShieldAlert className="w-12 h-12 text-amber-500" />}
            title={<span className="text-lg font-bold text-slate-900">{t("finance.bdForbidden")}</span>}
            description={
              <span className="text-sm text-slate-600 max-w-lg block mt-2 leading-relaxed">
                {t("finance.bdForbiddenDesc")}
              </span>
            }
            action={
              <Button
                variant="default"
                onClick={() => navigate("/dashboard")}
                className="mt-4"
              >
                {t("backToDashboard")}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (isInitialLoading) {
    return <PageLoading title={t("finance.bdLoading")} description={t("finance.bdLoadingDesc")} />;
  }

  if (revenueQ.isError && !revenueQ.data) {
    return (
      <PageError
        title={t("finance.bdLoadError")}
        error={revenueQ.error}
        onRetry={refetchAll}
      />
    );
  }

  const heatmapMatrix = heatmapQ.data?.matrix;
  const hasHeatmapData = Boolean(heatmapMatrix && Object.keys(heatmapMatrix).length > 0);

  return (
    <ErrorBoundary>
      <div className="space-y-6 max-w-7xl mx-auto w-full pb-24">
        {/* Top Header */}
        <PageHeader
          title={t("businessDataTitle") || t("finance.bdTitle")}
          description={t("businessDataSubtitle") || t("finance.bdSubtitle")}
          actions={
            <div className="flex items-center gap-2 flex-wrap">
              {/* 时间区间快选 */}
              <div className="flex bg-slate-100 p-1 rounded-xl text-xs font-semibold">
                {(
                  [
                    { id: "7d", label: t("finance.bdRange7") },
                    { id: "30d", label: t("finance.bdRange30") },
                    { id: "90d", label: t("finance.bdRange90") },
                    { id: "thisMonth", label: t("finance.bdRangeMonth") },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setRangePreset(p.id)}
                    className={`px-3 py-1.5 rounded-lg transition-all ${
                      rangePreset === p.id
                        ? "bg-white text-slate-900 shadow-2xs font-bold"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* 刷新 */}
              <Button
                variant="secondary"
                size="sm"
                className="bg-white border-slate-200"
                onClick={() => {
                  refetchAll();
                  toast.success(t("finance.bdRefreshed"));
                }}
              >
                <RefreshCw className={`w-4 h-4 text-slate-600 ${isLoading ? "animate-spin" : ""}`} />
              </Button>

              {/* 导出多维报表 */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 bg-white border-slate-200 text-xs font-bold"
                disabled={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    const headers = ["日期", "服务收入 ($)", "零售收入 ($)", "Gift Card销售 ($)", "净销售额 ($)", "订单单数"];
                    const rows = chartData.map((d) => [
                      d.name,
                      d.services.toFixed(2),
                      d.retail.toFixed(2),
                      d.giftCards.toFixed(2),
                      d.net.toFixed(2),
                      d.orders,
                    ]);
                    exportToCSV(`business-analytics-${from}-to-${to}`, headers, rows);
                    toast.success(t("finance.bdExported"));
                  } catch (err: any) {
                    toast.danger(errorMessage(err));
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                <Download className={`w-3.5 h-3.5 ${exporting ? "animate-bounce" : ""}`} />
                <span>{exporting ? t("finance.bdExporting") : t("finance.bdExport")}</span>
              </Button>
            </div>
          }
        />

        {/* 5 Core KPI Cockpit Radar Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <Card className="p-4 border-slate-200 shadow-2xs bg-gradient-to-br from-white to-teal-50/20">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{t("finance.bdNetGmv")}</span>
              <DollarSign className="w-4 h-4 text-teal-600" />
            </div>
            <p className="text-2xl font-black text-slate-900 mt-2 font-mono">
              ${totalNetRevenueDollars}
            </p>
            <div className="flex items-center gap-1 text-[11px] text-emerald-600 font-bold mt-1">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>{t("finance.bdGmvDelta")}</span>
            </div>
          </Card>

          <Card className="p-4 border-slate-200 shadow-2xs bg-gradient-to-br from-white to-blue-50/20">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{t("finance.bdTotalVisits")}</span>
              <Users className="w-4 h-4 text-blue-600" />
            </div>
            <p className="text-2xl font-black text-slate-900 mt-2 font-mono">
              {customersQ.data?.totalVisits ?? 0}
            </p>
            <div className="flex items-center justify-between text-[11px] text-slate-500 mt-1">
              <span>{t("finance.bdNewCustomers")} {customersQ.data?.newCustomerVisits ?? 0}</span>
              <span>{t("finance.bdReturningCustomers")} {customersQ.data?.returningCustomerVisits ?? 0}</span>
            </div>
          </Card>

          <Card className="p-4 border-slate-200 shadow-2xs bg-gradient-to-br from-white to-amber-50/20">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{t("finance.bdAov")}</span>
              <Award className="w-4 h-4 text-amber-600" />
            </div>
            <p className="text-2xl font-black text-slate-900 mt-2 font-mono">
              ${centsToDollars(customersQ.data?.averageTicketCents ?? 0)}
            </p>
            <div className="flex items-center gap-1 text-[11px] text-emerald-600 font-bold mt-1">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>{t("finance.bdAovDelta")}</span>
            </div>
          </Card>

          <Card className="p-4 border-slate-200 shadow-2xs bg-gradient-to-br from-white to-emerald-50/20">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{t("finance.bdRepeatRate")}</span>
              <UserCheck className="w-4 h-4 text-emerald-600" />
            </div>
            <p className="text-2xl font-black text-emerald-700 mt-2 font-mono">
              {(((customersQ.data?.retentionRateBp ?? 0)) / 100).toFixed(1)}%
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              {t("finance.bdDormant")} {customersQ.data?.sleepingCustomerCount ?? 0} {t("finance.bdPeopleUnit")}
            </p>
          </Card>

          <Card className="p-4 border-slate-200 shadow-2xs bg-gradient-to-br from-white to-purple-50/20 col-span-2 md:col-span-1">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{t("finance.bdUtilisation")}</span>
              <Zap className="w-4 h-4 text-purple-600" />
            </div>
            <p className="text-2xl font-black text-purple-700 mt-2 font-mono">
              {(((heatmapQ.data?.avgCapacityUtilizationBp ?? 0)) / 100).toFixed(1)}%
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              {heatmapQ.data?.peakHour ? `Peak: ${heatmapQ.data.peakHour}` : t("finance.bdTurnover")}
            </p>
          </Card>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-slate-200 gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab("revenue")}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === "revenue"
                ? "border-teal-600 text-teal-700 font-bold"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span>{t("finance.bdTabRevenue")}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("customers")}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === "customers"
                ? "border-teal-600 text-teal-700 font-bold"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <Users className="w-4 h-4" />
            <span>{t("finance.bdTabRfm")}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("categories")}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === "categories"
                ? "border-teal-600 text-teal-700 font-bold"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <Tag className="w-4 h-4" />
            <span>{t("finance.bdTabCategory")}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("staff")}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === "staff"
                ? "border-teal-600 text-teal-700 font-bold"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <Award className="w-4 h-4" />
            <span>{t("finance.bdTabStaff")}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("copilot")}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === "copilot"
                ? "border-teal-600 text-teal-700 font-bold"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <Sparkles className="w-4 h-4 text-amber-500" />
            <span>{t("finance.bdTabAi")}</span>
            <Badge variant="warning" className="text-[10px] px-1.5 py-0">Smart</Badge>
          </button>
        </div>

        {/* TAB 1: 营收与趋势走势 + 7x24h 营业高峰Heatmap */}
        {activeTab === "revenue" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* 主复合走势图 */}
              <Card className="lg:col-span-2 border-slate-200 shadow-2xs">
                <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-sm font-bold text-slate-900">
                      {t("finance.bdRevenueChartTitle")}
                    </CardTitle>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {t("finance.bdRevenueChartDesc")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-xs bg-teal-600 inline-block" />  {t("finance.bdLegendService")}</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-xs bg-blue-500 inline-block" />  {t("finance.bdLegendRetail")}</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" /> Gift Card</span>
                  </div>
                </CardHeader>
                <CardContent className="p-5">
                  {chartData.length === 0 ? (
                    <EmptyState
                      title={t("finance.bdNoData")}
                      description={t("finance.bdNoDataDesc")}
                      className="py-16"
                    />
                  ) : (
                    <div className="h-[320px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 20, right: 20, left: -10, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F1F5F9" />
                          <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "#64748B", fontSize: 11 }} dy={8} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fill: "#64748B", fontSize: 11 }} tickFormatter={(val) => `$${val}`} />
                          <RechartsTooltip
                            cursor={{ fill: "#F8FAFC" }}
                            contentStyle={{ borderRadius: "12px", border: "1px solid #E2E8F0", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.05)", fontSize: "12px" }}
                          />
                          <Bar dataKey="services" name={t("finance.bdSeriesService")} fill="#0D9488" stackId="a" radius={[0, 0, 0, 0]} />
                          <Bar dataKey="retail" name="Retail Products" fill="#3B82F6" stackId="a" radius={[0, 0, 0, 0]} />
                          <Bar dataKey="giftCards" name={t("finance.bdSeriesGiftCard")} fill="#F59E0B" stackId="a" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* 收入渠道与支付占比 */}
              <Card className="border-slate-200 shadow-2xs">
                <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5">
                  <CardTitle className="text-sm font-bold text-slate-900">
                    {t("finance.bdCategoryMixTitle")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-4">
                  {categoryData.length === 0 ? (
                    <EmptyState
                      title={t("finance.bdNoCategoryMix")}
                      className="py-12"
                    />
                  ) : (
                    <>
                      <div className="h-[180px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={categoryData}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              innerRadius={45}
                              outerRadius={75}
                              paddingAngle={3}
                            >
                              {categoryData.map((_, index) => (
                                <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                              ))}
                            </Pie>
                            <RechartsTooltip />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="space-y-2 text-xs">
                        {categoryData.map((item, idx) => (
                          <div key={item.name} className="flex justify-between items-center py-1 border-b border-slate-100 last:border-0">
                            <div className="flex items-center gap-2">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }}
                              />
                              <span className="text-slate-600 font-medium">{item.name}</span>
                            </div>
                            <div className="flex items-center gap-2 font-mono">
                              <span className="text-slate-900 font-bold">${item.value}</span>
                              <span className="text-slate-400 text-[11px]">({item.percent}%)</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* 营业高峰时段Heatmap (Peak Hours Heatmap) */}
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Flame className="w-4 h-4 text-orange-500" />
                    {t("finance.bdHeatmapTitle")}
                  </CardTitle>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {t("finance.bdHeatmapDesc")}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-slate-400">{t("finance.bdDensityLevel")}</span>
                  <span className="flex items-center gap-1 text-slate-600"><span className="w-3 h-3 rounded-xs bg-emerald-100 border border-emerald-200 inline-block" />  {t("finance.bdDensityIdle")}</span>
                  <span className="flex items-center gap-1 text-slate-600"><span className="w-3 h-3 rounded-xs bg-teal-300 inline-block" />  {t("finance.bdDensityModerate")}</span>
                  <span className="flex items-center gap-1 text-slate-600"><span className="w-3 h-3 rounded-xs bg-teal-600 inline-block" />  {t("finance.bdDensityBusy")}</span>
                  <span className="flex items-center gap-1 text-slate-600"><span className="w-3 h-3 rounded-xs bg-orange-500 inline-block" />  {t("finance.bdDensityFull")}</span>
                </div>
              </CardHeader>
              <CardContent className="p-5">
                {!hasHeatmapData ? (
                  <EmptyState
                    title={t("finance.bdNoHeatmapData")}
                    className="py-12"
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <div className="min-w-[640px]">
                      <div className="grid grid-cols-7 gap-2 mb-2 text-center text-xs font-bold text-slate-500">
                        <div className="text-left pl-2">{t("finance.bdWeekday")}</div>
                        {HOURS_RANGE.map((hr) => (
                          <div key={hr}>{hr}</div>
                        ))}
                      </div>

                      <div className="space-y-2">
                        {DAYS_OF_WEEK.map((day) => {
                          const rowScores = (heatmapMatrix as any)?.[day] || [0, 0, 0, 0, 0, 0];
                          return (
                            <div key={day} className="grid grid-cols-7 gap-2 items-center text-xs">
                              <div className="font-bold text-slate-800 pl-2">{day}</div>
                              {rowScores.map((score: number, i: number) => {
                                let bgClass = "bg-emerald-50 text-emerald-800 border border-emerald-200";
                                if (score >= 90) bgClass = "bg-orange-500 text-white font-bold shadow-xs";
                                else if (score >= 70) bgClass = "bg-teal-600 text-white font-bold";
                                else if (score >= 45) bgClass = "bg-teal-200 text-teal-900 font-semibold";

                                return (
                                  <div
                                    key={i}
                                    className={`h-10 rounded-xl flex flex-col items-center justify-center transition-all hover:scale-105 cursor-pointer ${bgClass}`}
                                    title={t("finance.bdHeatCell", { p0: day, p1: HOURS_RANGE[i], p2: score })}
                                  >
                                    <span className="font-mono text-xs">{score}%</span>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* TAB 2: 顾客画像与 RFM 价值矩阵 */}
        {activeTab === "customers" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* RFM 顾客价值矩阵 */}
              <Card className="lg:col-span-2 border-slate-200 shadow-2xs">
                <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5">
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <UserCheck className="w-4 h-4 text-teal-600" />
                    {t("finance.bdRfmTitle")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                    {/* VIP */}
                    <div className="p-4 rounded-xl border border-teal-200 bg-teal-50/40 space-y-2">
                      <div className="flex justify-between items-center font-bold">
                        <span className="text-teal-900 text-sm">{t("finance.bdRfmVip")}</span>
                        <Badge variant="success">{t("finance.bdRfmVipBadge") || "VIP"}</Badge>
                      </div>
                      <p className="text-slate-600">
                        {t("finance.bdCustomerCount")} <strong className="text-slate-900 font-mono">{rfmQ.data?.cohorts?.vip?.count ?? 0} {t("finance.bdPeopleUnit")}</strong> {t("finance.bdMonthlyVisitsLabel")} <strong className="text-slate-900 font-mono">{(rfmQ.data?.cohorts?.vip?.visitFrequency ?? 0).toFixed(1)} {t("finance.bdTurnUnit")}</strong> {t("finance.bdAvgTicketLabel")} <strong className="text-teal-700 font-mono">${centsToDollars(rfmQ.data?.cohorts?.vip?.avgTicketCents ?? 0)}</strong>
                      </p>
                      <p className="text-[11px] text-teal-800 bg-white/70 p-2 rounded-lg border border-teal-100">
                        {t("finance.bdRfmVipAction")}
                      </p>
                    </div>

                    {/* Active */}
                    <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/40 space-y-2">
                      <div className="flex justify-between items-center font-bold">
                        <span className="text-blue-900 text-sm">{t("finance.bdRfmActive")}</span>
                        <Badge variant="secondary">{t("finance.bdRfmActiveBadge") || "Active"}</Badge>
                      </div>
                      <p className="text-slate-600">
                        {t("finance.bdCustomerCount")} <strong className="text-slate-900 font-mono">{rfmQ.data?.cohorts?.active?.count ?? 0} {t("finance.bdPeopleUnit")}</strong> {t("finance.bdMonthlyVisitsLabel")} <strong className="text-slate-900 font-mono">{(rfmQ.data?.cohorts?.active?.visitFrequency ?? 0).toFixed(1)} {t("finance.bdTurnUnit")}</strong> {t("finance.bdAvgTicketLabel")} <strong className="text-blue-700 font-mono">${centsToDollars(rfmQ.data?.cohorts?.active?.avgTicketCents ?? 0)}</strong>
                      </p>
                      <p className="text-[11px] text-blue-800 bg-white/70 p-2 rounded-lg border border-blue-100">
                        {t("finance.bdRfmActiveAction")}
                      </p>
                    </div>

                    {/* New */}
                    <div className="p-4 rounded-xl border border-amber-200 bg-amber-50/40 space-y-2">
                      <div className="flex justify-between items-center font-bold">
                        <span className="text-amber-900 text-sm">{t("finance.bdRfmNew")}</span>
                        <Badge variant="warning">{t("finance.bdRfmNewBadge") || "New"}</Badge>
                      </div>
                      <p className="text-slate-600">
                        {t("finance.bdCustomerCount")} <strong className="text-slate-900 font-mono">{rfmQ.data?.cohorts?.new?.count ?? 0} {t("finance.bdPeopleUnit")}</strong> {t("finance.bdFirstTicket")} <strong className="text-slate-900 font-mono">${centsToDollars(rfmQ.data?.cohorts?.new?.avgFirstTicketCents ?? 0)}</strong> {t("finance.bdSecondVisitRate")} <strong className="text-amber-700 font-mono">{(((rfmQ.data?.cohorts?.new?.secondVisitRateBp ?? 0)) / 100).toFixed(1)}%</strong>
                      </p>
                      <p className="text-[11px] text-amber-800 bg-white/70 p-2 rounded-lg border border-amber-100">
                        {t("finance.bdRfmNewAction")}
                      </p>
                    </div>

                    {/* At Risk */}
                    <div className="p-4 rounded-xl border border-red-200 bg-red-50/40 space-y-2">
                      <div className="flex justify-between items-center font-bold">
                        <span className="text-red-900 text-sm">{t("finance.bdRfmAtRisk")}</span>
                        <Badge variant="outline" className="text-red-600 border-red-200">{t("finance.bdNoVisit60")}</Badge>
                      </div>
                      <p className="text-slate-600">
                        {t("finance.bdDormantCount")} <strong className="text-slate-900 font-mono">{rfmQ.data?.cohorts?.sleeping?.count ?? 0} {t("finance.bdPeopleUnit")}</strong> {t("finance.bdPotentialLoss")} <strong className="text-red-600 font-mono">~${centsToDollars(rfmQ.data?.cohorts?.sleeping?.atRiskRevenueCents ?? 0)}</strong>
                      </p>
                      <p className="text-[11px] text-red-800 bg-white/70 p-2 rounded-lg border border-red-100">
                        {t("finance.bdRfmAtRiskAction")}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* 获客来源渠道 */}
              <Card className="border-slate-200 shadow-2xs">
                <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5">
                  <CardTitle className="text-sm font-bold text-slate-900">
                    {t("finance.bdAcquisitionTitle")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-4">
                  {channelData.length === 0 ? (
                    <EmptyState
                      title={t("finance.bdAcquisitionTitle")}
                      className="py-12"
                    />
                  ) : (
                    <>
                      <div className="h-[180px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={channelData}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              innerRadius={45}
                              outerRadius={75}
                              paddingAngle={3}
                            >
                              {channelData.map((_, index) => (
                                <Cell key={`cell-${index}`} fill={CHANNEL_COLORS[index % CHANNEL_COLORS.length]} />
                              ))}
                            </Pie>
                            <RechartsTooltip />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="space-y-2 text-xs">
                        {channelData.map((c, i) => (
                          <div key={c.name} className="flex justify-between items-center py-1 border-b border-slate-100 last:border-0">
                            <div className="flex items-center gap-2">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }}
                              />
                              <span className="text-slate-600">{c.name}</span>
                            </div>
                            <span className="font-mono font-bold text-slate-900">{c.percent}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* TAB 3: 品类毛利与爆款项目榜 */}
        {activeTab === "categories" && (
          <div className="space-y-6">
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Tag className="w-4 h-4 text-teal-600" />
                    {t("finance.bdTopServicesTitle")}
                  </CardTitle>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {t("finance.bdTopServicesDesc")}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {topServicesList.length === 0 ? (
                  <EmptyState
                    title={t("finance.bdNoTopServices")}
                    className="py-16"
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/60 text-slate-500 font-bold">
                          <th className="py-3 px-5">{t("finance.bdColRank")}</th>
                          <th className="py-3 px-5">{t("finance.bdColService")}</th>
                          <th className="py-3 px-5">{t("finance.bdColCategory")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColVolume")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColRevenue")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColMargin")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColDuration")}</th>
                          <th className="py-3 px-5">{t("finance.bdColRating")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {topServicesList.map((s) => (
                          <tr key={s.name} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3 px-5 font-bold font-mono">
                              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] ${
                                s.rank === 1
                                  ? "bg-amber-400 text-amber-950 font-black"
                                  : s.rank === 2
                                  ? "bg-slate-300 text-slate-800 font-black"
                                  : s.rank === 3
                                  ? "bg-amber-700 text-white font-black"
                                  : "bg-slate-100 text-slate-600"
                              }`}>
                                {s.rank}
                              </span>
                            </td>
                            <td className="py-3 px-5 font-bold text-slate-900">{s.name}</td>
                            <td className="py-3 px-5">
                              <Badge variant="outline" className="text-[11px]">{s.category}</Badge>
                            </td>
                            <td className="py-3 px-5 font-mono font-bold text-slate-900">{s.salesCount}  {t("finance.bdTicketUnit")}</td>
                            <td className="py-3 px-5 font-mono font-black text-teal-700">
                              ${centsToDollars(s.revenueCents)}
                            </td>
                            <td className="py-3 px-5 font-mono font-bold text-emerald-700">{s.margin}</td>
                            <td className="py-3 px-5 font-mono text-slate-500">{s.avgMins}  {t("finance.bdMinuteUnit")}</td>
                            <td className="py-3 px-5 flex items-center gap-1 font-bold text-amber-600">
                              <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                              <span>{s.rating.toFixed(1)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* TAB 4: 技师效能战力榜 */}
        {activeTab === "staff" && (
          <div className="space-y-6">
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Award className="w-4 h-4 text-teal-600" />
                    {t("finance.bdStaffMatrixTitle")}
                  </CardTitle>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {t("finance.bdStaffMatrixDesc")}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {(staffQ.data?.rows ?? []).length === 0 ? (
                  <p className="text-xs text-slate-400 py-12 text-center">{t("finance.bdNoStaffPerf")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/60 text-slate-500 font-bold">
                          <th className="py-3 px-5">{t("finance.bdColStaffName")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColTicketsDone")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColSales")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColTips")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColRequestRate")}</th>
                          <th className="py-3 px-5 font-mono">{t("finance.bdColEstCommission")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {(staffQ.data?.rows ?? []).map((row) => (
                          <tr key={row.membershipId} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3 px-5 font-bold text-slate-900 flex items-center gap-2">
                              <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-800 flex items-center justify-center font-bold text-[11px]">
                                {row.name.slice(0, 1)}
                              </span>
                              <span>{row.name}</span>
                            </td>
                            <td className="py-3 px-5 font-mono font-bold text-slate-800">{row.serviceCount}  {t("finance.bdTicketUnit2")}</td>
                            <td className="py-3 px-5 font-mono font-black text-teal-700">
                              ${centsToDollars(row.salesCents)}
                            </td>
                            <td className="py-3 px-5 font-mono font-bold text-amber-700">
                              ${centsToDollars(row.tipsCents)}
                            </td>
                            <td className="py-3 px-5 font-mono">
                              <Badge variant={row.requestRateBp >= 4000 ? "success" : "outline"} className="text-[11px]">
                                {(((row.requestRateBp || 0)) / 100).toFixed(1)}%
                              </Badge>
                            </td>
                            <td className="py-3 px-5 font-mono font-bold text-slate-900">
                              ${centsToDollars(row.commissionCents ?? 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* TAB 5: AI 智能经营诊断 */}
        {activeTab === "copilot" && (
          <div className="space-y-6">
            <Card className="border-amber-200 bg-gradient-to-br from-amber-50/30 via-white to-teal-50/20 shadow-2xs p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-amber-100 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-amber-500 text-white flex items-center justify-center shadow-sm">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900">{t("finance.bdAiTitle")}</h3>
                    <p className="text-xs text-slate-500">
                      {t("finance.bdAiDesc")}
                    </p>
                  </div>
                </div>
                <Badge variant="warning" className="text-xs font-bold">
                  {t("finance.bdAiReady")}
                </Badge>
              </div>

              {!hasCopilotData ? (
                <EmptyState
                  title={t("finance.bdNoAiInsights")}
                  className="py-12"
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* 经营亮点 */}
                  <div className="p-4 rounded-xl bg-emerald-50/60 border border-emerald-200 space-y-2 text-xs">
                    <div className="flex items-center gap-1.5 font-bold text-emerald-900 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>{t("finance.bdHighlights")}</span>
                    </div>
                    {copilotHighlights.length === 0 ? (
                      <p className="text-slate-400 text-xs py-4">{t("finance.bdNoAiInsights")}</p>
                    ) : (
                      <ul className="list-disc list-inside space-y-1.5 text-emerald-800 text-[11px] leading-relaxed">
                        {copilotHighlights.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* 风险预警 */}
                  <div className="p-4 rounded-xl bg-red-50/60 border border-red-200 space-y-2 text-xs">
                    <div className="flex items-center gap-1.5 font-bold text-red-900 text-sm">
                      <AlertTriangle className="w-4 h-4 text-red-600" />
                      <span>{t("finance.bdRisks")}</span>
                    </div>
                    {copilotRisks.length === 0 ? (
                      <p className="text-slate-400 text-xs py-4">{t("finance.bdNoAiInsights")}</p>
                    ) : (
                      <ul className="list-disc list-inside space-y-1.5 text-red-800 text-[11px] leading-relaxed">
                        {copilotRisks.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* 定向增长营销动作 */}
                  <div className="p-4 rounded-xl bg-teal-50/60 border border-teal-200 space-y-2 text-xs">
                    <div className="flex items-center gap-1.5 font-bold text-teal-900 text-sm">
                      <Zap className="w-4 h-4 text-teal-600" />
                      <span>{t("finance.bdAiActions")}</span>
                    </div>
                    {copilotActions.length === 0 ? (
                      <p className="text-slate-400 text-xs py-4">{t("finance.bdNoAiInsights")}</p>
                    ) : (
                      <ul className="list-disc list-inside space-y-1.5 text-teal-800 text-[11px] leading-relaxed">
                        {copilotActions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}
