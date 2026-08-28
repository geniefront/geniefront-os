import { useState, useEffect } from "react";
import { useErrorMessage } from '@/lib/errorMessage';
import { toast } from "@heroui/react";
import { useLanguage } from "@/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { SampleDataNotice } from '@/components/ui/SampleDataNotice';
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal, ConfirmDialog } from "@/components/ui/Modal";
import { PageLoading, PageError } from "@/components/ui/QueryState";
import {
  Store,
  Upload,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  Globe,
  Smartphone,
  Monitor,
  Calendar,
  MessageSquare,
  FileCheck2,
  Layers,
  ArrowRight,
  Send,
  ExternalLink,
  ShieldCheck,
  Paintbrush,
  Users,
  Star,
  MapPin,
  Clock,
  ChevronRight,
  Info,
  Check,
  Building2,
} from "lucide-react";
import {
  useBlueprintsQuery,
  useStorefrontBriefQuery,
  useSaveStorefrontDraft,
  useStorefrontRevisionsQuery,
  useAddStorefrontRevisionMutation,
} from "@/features/storefront/api";

export function StorefrontBuilder() {
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const { data: blueprintData, isLoading: isBlueprintLoading } = useBlueprintsQuery();
  const { data: briefData, isLoading: isBriefLoading, isError: isBriefError, error: briefError, refetch } = useStorefrontBriefQuery();
  const { data: revisionsData } = useStorefrontRevisionsQuery();
  const saveDraftMutation = useSaveStorefrontDraft();
  const addRevisionMutation = useAddStorefrontRevisionMutation();

  const isInitialLoading = isBriefLoading && isBlueprintLoading && !briefData && !blueprintData;

  // 当前激活的视图 Tab
  const [activeTab, setActiveTab] = useState<"brief" | "pipeline" | "preview">("brief");

  // 预览设备模式
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");

  // 品牌建站资料提报表单状态
  const [storeTitle, setStoreTitle] = useState("Lotus Wellness & Spa");
  const [storeSlogan, setStoreSlogan] = useState("Manhattan Premium Japanese Spa & Wellness Center");
  const [tone, setTone] = useState<"modern" | "luxury" | "zen" | "warm">("zen");
  const [primaryColor, setPrimaryColor] = useState("#0d9488");
  const [customUsp, setCustomUsp] = useState(
    "Over 10 years of licensed therapeutic expertise, featuring 100% natural organic essential oils, luxury private VIP suites, and herbal foot soaks."
  );
  const [existingWebsiteUrl, setExistingWebsiteUrl] = useState("https://instagram.com/lotus_spa_nyc");
  const [photoDriveUrl, setPhotoDriveUrl] = useState("https://drive.google.com/drive/folders/lotus-spa-photos");
  const [selectedModules, setSelectedModules] = useState<string[]>([
    "online_booking",
    "service_menu",
    "therapist_showcase",
    "google_reviews",
    "location_map",
    "multilingual",
  ]);

  // 从服务端加载已保存的建站需求数据并填入表单
  useEffect(() => {
    if (briefData) {
      if (briefData.shopName) setStoreTitle(briefData.shopName);
      if (briefData.slogan) setStoreSlogan(briefData.slogan);
      if (briefData.brief) {
        const b = briefData.brief;
        if (b.brandPrimary) setPrimaryColor(b.brandPrimary);
        if (b.tone || b.voice) setTone((b.tone || b.voice) as any);
        if (b.usp) setCustomUsp(b.usp);
        if (b.currentSiteUrl) setExistingWebsiteUrl(b.currentSiteUrl);
        if (b.painPoints && Array.isArray(b.painPoints) && b.painPoints.length > 0) {
          setSelectedModules(b.painPoints);
        }
      }
    }
  }, [briefData]);

  useEffect(() => {
    if (revisionsData?.revisions && revisionsData.revisions.length > 0) {
      setRevisionList(revisionsData.revisions);
    }
  }, [revisionsData]);

  // 修改意见提报
  const [revisionNote, setRevisionNote] = useState("");
  const [revisionList, setRevisionList] = useState<
    Array<{ id: string; time: string; text: string; status: string }>
  >([
    {
      id: "rev-1",
      time: "2026-08-25 14:30",
      text: "请将首页深层精油按摩的价格从 $85 更新为 $95，并加上『赠送 15min 热石体验』的角标。",
      status: "已修改采纳",
    },
    {
      id: "rev-2",
      time: "2026-08-26 10:15",
      text: "把技师团队展示里的 Lisa 师傅头像更换为 Drive 链接中的第一张高清肖像图。",
      status: "设计处理中",
    },
  ]);

  // 模拟微店交互：在线预约弹窗
  const [bookingDemoModalOpen, setBookingDemoModalOpen] = useState(false);
  const [selectedServiceInDemo, setSelectedServiceInDemo] = useState("60min 尊享深层芳疗精油按摩 ($95)");

  // 二次确认弹窗状态
  const [confirmBriefOpen, setConfirmBriefOpen] = useState(false);
  const [confirmRevisionOpen, setConfirmRevisionOpen] = useState(false);
  const [confirmLaunchOpen, setConfirmLaunchOpen] = useState(false);

  const toggleModule = (id: string) => {
    setSelectedModules((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  };

  const handleExecuteSaveBrief = async () => {
    try {
      await saveDraftMutation.mutateAsync({
        voice: tone as any,
        brandPrimary: primaryColor,
        painPoints: selectedModules,
        usp: customUsp || undefined,
        currentSiteUrl: existingWebsiteUrl || undefined,
        sections: selectedModules,
      });
      toast.success(t('settings.sfBriefSubmitted'));
      setConfirmBriefOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
      setConfirmBriefOpen(false);
    }
  };

  const handleExecuteSubmitRevision = async () => {
    if (!revisionNote.trim()) {
      toast("请填写具体修改意见");
      return;
    }
    try {
      const res = await addRevisionMutation.mutateAsync({ text: revisionNote.trim() });
      if (res?.revisions) {
        setRevisionList(res.revisions);
      }
      setRevisionNote("");
      setConfirmRevisionOpen(false);
      toast.success(t('settings.sfFeedbackSent'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
      setConfirmRevisionOpen(false);
    }
  };

  const handleExecuteLaunch = () => {
    setConfirmLaunchOpen(false);
    toast.success(t('settings.sfGoLiveSubmitted'));
  };

  if (isInitialLoading) {
    return <PageLoading title={t('settings.sfLoading')} description={t('settings.sfLoadingDesc')} />;
  }

  if (isBriefError && !briefData) {
    return (
      <PageError
        title={t('settings.sfLoadError')}
        error={briefError}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-6 pb-20 max-w-7xl mx-auto">
      <SampleDataNotice />
      {/* 顶部微店服务总览与上线流水线卡片 */}
      <div className="p-5 rounded-2xl bg-gradient-to-r from-slate-900 via-teal-950 to-slate-900 text-white shadow-lg space-y-4">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-teal-500/20 border border-teal-400/30 flex items-center justify-center shrink-0">
              <Globe className="w-6 h-6 text-teal-300" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold tracking-tight">{t('settings.sfTitle')}</h2>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-teal-500/20 text-teal-300 border border-teal-400/30">
                  <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse" />
                  
                  {t('settings.sfTicketInProgress')}
                </span>
              </div>
              <p className="text-xs text-teal-100/80 mt-1">
                
                {t('settings.sfIntro')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="https://lotusspa.geniefront.app"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-mono font-bold flex items-center gap-1.5 border border-white/20 transition-colors"
            >
              <span>lotusspa.geniefront.app</span>
              <ExternalLink className="w-3.5 h-3.5 text-teal-300" />
            </a>
          </div>
        </div>

        {/* 5 阶段定制建站交付流水线 */}
        <div className="pt-2 border-t border-white/10">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            {[
              { step: t('settings.sfStep1'), status: "completed", desc: t('settings.sfStep1Status') },
              { step: t('settings.sfStep2'), status: "completed", desc: t('settings.sfStep2Status') },
              { step: t('settings.sfStep3'), status: "active", desc: t('settings.sfStep3Status') },
              { step: t('settings.sfStep4'), status: "pending", desc: t('settings.sfStep4Status') },
              { step: t('settings.sfStep5'), status: "pending", desc: t('settings.sfStep5Status') },
            ].map((st, idx) => (
              <div
                key={idx}
                className={`p-2.5 rounded-xl border transition-all ${
                  st.status === "completed"
                    ? "bg-teal-500/20 border-teal-400/40 text-teal-200"
                    : st.status === "active"
                    ? "bg-amber-500/20 border-amber-400/50 text-amber-200 font-bold"
                    : "bg-white/5 border-white/10 text-slate-400"
                }`}
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span>{st.step}</span>
                  {st.status === "completed" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-teal-400" />
                  ) : st.status === "active" ? (
                    <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                  ) : null}
                </div>
                <p className="text-[10px] opacity-80 mt-0.5">{st.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 选项卡切换 Navigation */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab("brief")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
              activeTab === "brief"
                ? "bg-teal-600 text-white shadow-sm"
                : "bg-white text-slate-600 hover:bg-slate-50 border border-slate-200"
            }`}
          >
            <Paintbrush className="w-3.5 h-3.5" />
            
            {t('settings.sfTab1')}
          </button>
          <button
            onClick={() => setActiveTab("pipeline")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
              activeTab === "pipeline"
                ? "bg-teal-600 text-white shadow-sm"
                : "bg-white text-slate-600 hover:bg-slate-50 border border-slate-200"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            
            {t('settings.sfTab2')}{revisionList.length})
          </button>
          <button
            onClick={() => setActiveTab("preview")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
              activeTab === "preview"
                ? "bg-teal-600 text-white shadow-sm"
                : "bg-white text-slate-600 hover:bg-slate-50 border border-slate-200"
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            
            {t('settings.sfTab3')}
          </button>
        </div>

        {activeTab === "preview" && (
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => setPreviewDevice("desktop")}
              className={`p-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-all ${
                previewDevice === "desktop" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />  {t('settings.sfDesktop')}
            </button>
            <button
              onClick={() => setPreviewDevice("mobile")}
              className={`p-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-all ${
                previewDevice === "mobile" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" />  {t('settings.sfMobile')}
            </button>
          </div>
        )}
      </div>

      {/* Tab 1: 品牌建站资料提报 */}
      {activeTab === "brief" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 p-6 border-slate-200 shadow-sm space-y-6">
            <div>
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <Building2 className="w-4 h-4 text-teal-600" />
                
                {t('settings.sfSection1')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                
                {t('settings.sfSection1Desc')}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1.5">{t('settings.sfStoreName')}</label>
                <Input
                  value={storeTitle}
                  onChange={(e) => setStoreTitle(e.target.value)}
                  placeholder={t('settings.sfNamePlaceholder')}
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1.5">{t('settings.sfSlogan')}</label>
                <Input
                  value={storeSlogan}
                  onChange={(e) => setStoreSlogan(e.target.value)}
                  placeholder={t('settings.sfSloganPlaceholder')}
                />
              </div>
            </div>

            {/* 视觉调性与主色调 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs pt-1">
              <div>
                <label className="block font-bold text-slate-700 mb-1.5">{t('settings.sfBrandColor')}</label>
                <div className="flex items-center gap-2.5">
                  <input
                    type="color"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className="w-9 h-9 rounded-xl cursor-pointer border border-slate-200 p-0 shadow-sm shrink-0"
                  />
                  <Input
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className="font-mono uppercase text-xs flex-1"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1.5">{t('settings.sfVisualStyle')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: "zen", label: t('settings.sfStyleZen') },
                    { id: "luxury", label: t('settings.sfStyleLuxury') },
                    { id: "modern", label: t('settings.sfStyleModern') },
                    { id: "warm", label: t('settings.sfStyleWarm') },
                  ].map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setTone(v.id as any)}
                      className={`p-2 rounded-xl border text-left font-medium transition-all ${
                        tone === v.id
                          ? "border-teal-600 bg-teal-50 text-teal-950 font-bold"
                          : "border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 核心卖点与亮点 */}
            <div className="pt-1 text-xs">
              <label className="block font-bold text-slate-700 mb-1.5">{t('settings.sfUsp')}</label>
              <textarea
                rows={3}
                value={customUsp}
                onChange={(e) => setCustomUsp(e.target.value)}
                placeholder={t('settings.sfUspPlaceholder')}
                className="w-full p-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 text-slate-800 leading-relaxed"
              />
            </div>

            {/* 功能模块勾选 */}
            <div className="pt-2 text-xs">
              <label className="block font-bold text-slate-700 mb-2">{t('settings.sfFeatureModules')}</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {[
                  { id: "online_booking", label: t('settings.sfFeatureBooking') },
                  { id: "service_menu", label: t('settings.sfFeaturePricing') },
                  { id: "therapist_showcase", label: t('settings.sfFeatureTeam') },
                  { id: "google_reviews", label: t('settings.sfFeatureReviews') },
                  { id: "location_map", label: t('settings.sfFeatureMap') },
                  { id: "multilingual", label: t('settings.sfFeatureI18n') },
                ].map((m) => {
                  const active = selectedModules.includes(m.id);
                  return (
                    <div
                      key={m.id}
                      onClick={() => toggleModule(m.id)}
                      className={`p-2.5 rounded-xl border cursor-pointer flex items-center justify-between transition-colors ${
                        active
                          ? "bg-teal-50/80 border-teal-300 text-teal-950 font-bold"
                          : "border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <span>{m.label}</span>
                      {active && <Check className="w-3.5 h-3.5 text-teal-600 shrink-0" />}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 素材与参考链接 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs pt-2">
              <div>
                <label className="block font-bold text-slate-700 mb-1.5">{t('settings.sfSocialRefs')}</label>
                <Input
                  value={existingWebsiteUrl}
                  onChange={(e) => setExistingWebsiteUrl(e.target.value)}
                  placeholder="https://instagram.com/..."
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1.5">{t('settings.sfPhotoLink')}</label>
                <Input
                  value={photoDriveUrl}
                  onChange={(e) => setPhotoDriveUrl(e.target.value)}
                  placeholder="https://drive.google.com/..."
                />
              </div>
            </div>

            <div className="flex justify-end pt-4 border-t border-slate-100">
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-md gap-1.5"
                disabled={saveDraftMutation.isPending}
                onClick={() => setConfirmBriefOpen(true)}
              >
                <Sparkles className="w-3.5 h-3.5" />
                {saveDraftMutation.isPending ? t('settings.sfSubmitting') : t('settings.sfSubmitBrief')}
              </Button>
            </div>
          </Card>

          {/* 右侧设计专属顾问服务卡片 */}
          <div className="space-y-4">
            <Card className="p-5 border-teal-200 bg-teal-50/50 shadow-sm space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-teal-600 text-white font-bold flex items-center justify-center text-sm shadow-sm">
                  GF
                </div>
                <div>
                  <h4 className="font-bold text-teal-950 text-xs">{t('settings.sfTeamTitle')}</h4>
                  <p className="text-[11px] text-teal-800">{t('settings.sfTeamDesc')}</p>
                </div>
              </div>

              <div className="text-xs space-y-2 text-slate-700 leading-relaxed">
                <p>
                  • <strong>{t('settings.sfPoint1Bold')}</strong>{t('settings.sfPoint1Body')}
                </p>
                <p>
                  • <strong>{t('settings.sfPoint2Bold')}</strong>{t('settings.sfPoint2Body')}
                </p>
                <p>
                  • <strong>{t('settings.sfPoint3Bold')}</strong>{t('settings.sfPoint3Body')}
                </p>
              </div>

              <div className="p-3 rounded-xl bg-white border border-teal-200 text-xs space-y-1">
                <span className="font-bold text-slate-900">{t('settings.sfDomainTitle')}</span>
                <p className="text-slate-500 text-[11px]">
                  
                  {t('settings.sfDomainBody')}
                </p>
              </div>
            </Card>

            <Button
              variant="secondary"
              className="w-full text-xs font-bold text-slate-700 h-10 gap-1.5"
              onClick={() => setActiveTab("preview")}
            >
              <Globe className="w-3.5 h-3.5 text-teal-600" />
              
              {t('settings.sfGoPreview')}
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Tab 2: 交付进度与修改反馈 */}
      {activeTab === "pipeline" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 p-6 border-slate-200 shadow-sm space-y-6">
            <div>
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-teal-600" />
                
                {t('settings.sfFeedbackTitle')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                
                {t('settings.sfFeedbackDesc')}
              </p>
            </div>

            <div className="space-y-2 text-xs">
              <label className="font-bold text-slate-700">{t('settings.sfFeedbackLabel')}</label>
              <textarea
                rows={4}
                value={revisionNote}
                onChange={(e) => setRevisionNote(e.target.value)}
                placeholder={t('settings.sfFeedbackPlaceholder')}
                className="w-full p-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 text-slate-800"
              />
              <div className="flex justify-end">
                <Button
                  className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs gap-1.5"
                  onClick={() => setConfirmRevisionOpen(true)}
                >
                  <Send className="w-3.5 h-3.5" />
                  
                  {t('settings.sfSubmitFeedback')}
                </Button>
              </div>
            </div>

            <div className="space-y-3 pt-4 border-t border-slate-100">
              <h4 className="font-bold text-slate-900 text-xs">{t('settings.sfHistoryTitle')}</h4>
              <div className="space-y-2">
                {revisionList.map((rev) => (
                  <div
                    key={rev.id}
                    className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] text-slate-400">{rev.time}</span>
                      <Badge
                        variant={rev.status === t('settings.sfRevisionAccepted') ? "success" : "warning"}
                        className="text-[10px]"
                      >
                        {rev.status}
                      </Badge>
                    </div>
                    <p className="text-slate-800 font-medium leading-relaxed">{rev.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card className="p-5 border-slate-200 shadow-sm space-y-4 text-xs">
            <h4 className="font-bold text-slate-900 text-sm">{t('settings.sfTicketInfo')}</h4>
            <div className="space-y-2 text-slate-600">
              <div className="flex justify-between p-2 rounded-lg bg-slate-50">
                <span>{t('settings.sfTicketNo')}</span>
                <span className="font-mono font-bold text-slate-800">SF-2026-0881</span>
              </div>
              <div className="flex justify-between p-2 rounded-lg bg-slate-50">
                <span>{t('settings.sfDesigner')}</span>
                <span className="font-bold text-teal-700">Alex Mitchell</span>
              </div>
              <div className="flex justify-between p-2 rounded-lg bg-slate-50">
                <span>{t('settings.sfLastUpdated')}</span>
                <span className="font-mono text-slate-800">{t('settings.sfUpdatedAt')}</span>
              </div>
              <div className="flex justify-between p-2 rounded-lg bg-slate-50">
                <span>{t('settings.sfCurrentVersion')}</span>
                <span className="font-bold text-slate-800">{t('settings.sfVersionNote')}</span>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-teal-50 border border-teal-200 text-teal-950 space-y-1">
              <span className="font-bold">{t('settings.sfDesignerNote')}</span>
              <p className="text-[11px] leading-relaxed">
                
                {t('settings.sfDesignerNoteBody')}
              </p>
            </div>
          </Card>
        </div>
      )}

      {/* Tab 3: 官网高保真真机实时交互预览 */}
      {activeTab === "preview" && (
        <div className="bg-slate-100 rounded-3xl p-4 sm:p-8 flex justify-center items-center overflow-auto border border-slate-200">
          <div
            className={`bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col transition-all duration-300 ${
              previewDevice === "desktop" ? "w-full max-w-4xl min-h-[620px]" : "w-[375px] min-h-[680px]"
            }`}
          >
            {/* 模拟浏览器顶部导航栏 */}
            <div className="p-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2 text-xs text-slate-400 shrink-0">
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                </div>
                <div className="bg-white border border-slate-200 rounded-lg px-3 py-1 flex items-center gap-1.5 font-mono text-[11px] text-slate-600 shadow-inner">
                  <Globe className="w-3 h-3 text-teal-600 shrink-0" />
                  <span>https://www.geniefront.com/demo-site/</span>
                  <span className="text-[10px] text-emerald-600 font-bold ml-1">{t('settings.sfSslEncrypted')}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const iframe = document.getElementById("demo-site-iframe") as HTMLIFrameElement;
                    if (iframe) iframe.src = iframe.src;
                    toast.success(t('settings.sfPreviewReloaded'));
                  }}
                  className="text-xs h-7 px-2 text-slate-600 hover:text-slate-900 gap-1"
                >
                  <RefreshCw className="w-3 h-3" />
                  
                  {t('settings.sfReload')}
                </Button>
                <a
                  href="https://www.geniefront.com/demo-site/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-bold text-teal-700 hover:text-teal-800 bg-teal-50 px-2.5 py-1 rounded-lg border border-teal-200"
                >
                  <ExternalLink className="w-3 h-3" />
                  
                  {t('settings.sfOpenNewTab')}
                </a>
              </div>
            </div>

            {/* 真实高保真微店 iframe 浏览器 */}
            <div className="relative flex-1 w-full bg-slate-50 flex flex-col min-h-[640px]">
              <iframe
                id="demo-site-iframe"
                src="https://www.geniefront.com/demo-site/"
                title="GenieFront Live Storefront"
                className="w-full flex-1 border-0 rounded-b-3xl"
                style={{ height: previewDevice === "desktop" ? "700px" : "740px" }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              />
            </div>
          </div>
        </div>
      )}

      {/* 模拟官网在线预约弹窗 */}
      <Modal
        isOpen={bookingDemoModalOpen}
        onOpenChange={setBookingDemoModalOpen}
        size="md"
        title={t('settings.sfWidgetSim')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" size="sm" onClick={() => setBookingDemoModalOpen(false)}>
              
              {t('settings.sfClosePreview')}
            </Button>
            <Button
              size="sm"
              className="bg-teal-600 text-white font-bold"
              onClick={() => {
                setBookingDemoModalOpen(false);
                toast.success(t('settings.sfSimBooked'));
              }}
            >
              
              {t('settings.sfSimSubmit')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 py-2 text-xs">
          <div className="p-3 rounded-xl bg-teal-50 border border-teal-200 space-y-1">
            <span className="font-bold text-teal-900">{t('settings.sfSelectedService')}</span>
            <p className="font-semibold text-teal-800">{selectedServiceInDemo}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-600 mb-1">{t('settings.sfVisitDate')}</label>
              <Input type="date" defaultValue="2026-08-28" />
            </div>
            <div>
              <label className="block font-semibold text-slate-600 mb-1">{t('settings.sfPreferredSlot')}</label>
              <Input type="time" defaultValue="14:30" />
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-600 mb-1">{t('settings.sfCustomerContact')}</label>
            <Input placeholder="Emily Chen (+1 212-555-0192)" defaultValue="Emily Chen (+1 212-555-0192)" />
          </div>
        </div>
      </Modal>

      {/* 提交建站资料二次确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmBriefOpen}
        onOpenChange={setConfirmBriefOpen}
        title={t('settings.sfBriefConfirmTitle')}
        description={t('settings.sfBriefConfirmBody')}
        confirmLabel={t('settings.sfBriefConfirmAction')}
        onConfirm={handleExecuteSaveBrief}
      />

      {/* 提交修改意见二次确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmRevisionOpen}
        onOpenChange={setConfirmRevisionOpen}
        title={t('settings.sfFeedbackConfirmTitle')}
        description={
          <div className="space-y-1.5 text-xs text-slate-600 mt-2">
            <p className="font-bold text-slate-800">{t('settings.sfFeedbackContent')}</p>
            <p className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg italic">
              "{revisionNote}"
            </p>
            <p className="text-[11px] text-slate-400">{t('settings.sfFeedbackEta')}</p>
          </div>
        }
        confirmLabel={t('settings.sfFeedbackConfirmAction')}
        onConfirm={handleExecuteSubmitRevision}
      />

      {/* 申请正式上线二次确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmLaunchOpen}
        onOpenChange={setConfirmLaunchOpen}
        title={t('settings.sfGoLiveConfirmTitle')}
        description={t('settings.sfGoLiveConfirmBody')}
        confirmLabel={t('settings.sfGoLiveConfirmAction')}
        onConfirm={handleExecuteLaunch}
      />
    </div>
  );
}