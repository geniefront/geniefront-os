import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarClock,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileSpreadsheet,
  Globe2,
  ImagePlus,
  Languages,
  MapPinned,
  MessageSquareText,
  PhoneCall,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  UserRoundCheck,
  WalletCards,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useSession } from '@/lib/session';
import { pickText } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { cn } from '@/lib/utils';
import { SETUP_STEPS, type SetupStepId } from '@/features/setup/flow';

const IMPORT_SOURCES = [
  {
    id: 'google',
    name: 'Google',
    icon: MapPinned,
    description: '搜索商家或粘贴 Google Maps 链接，带回地址、电话、营业时间和照片。',
    tone: 'border-blue-200 bg-blue-50/60 text-blue-700',
  },
  {
    id: 'yelp',
    name: 'Yelp',
    icon: Star,
    description: '输入店名和邮编，选择正确门店后逐项导入公开资料。',
    tone: 'border-red-200 bg-red-50/60 text-red-700',
  },
  {
    id: 'website',
    name: '扫描官网',
    icon: Globe2,
    description: '扫描官网中的门店信息、项目、价格、员工、图片和常见问题。',
    tone: 'border-violet-200 bg-violet-50/60 text-violet-700',
  },
  {
    id: 'menu',
    name: '扫描价目表',
    icon: Camera,
    description: '上传照片、PDF、Excel 或网页截图，识别分类、项目、价格和时长。',
    tone: 'border-amber-200 bg-amber-50/60 text-amber-700',
  },
] as const;

const STEP_CHECKLISTS: Record<Exclude<SetupStepId, 'import'>, Array<{ icon: typeof Check; label: string }>> = {
  store: [
    { icon: Building2, label: '店名、行业与联系方式' },
    { icon: MapPinned, label: '地址、时区与营业日边界' },
    { icon: CalendarClock, label: '每周营业时间与节假日' },
    { icon: Languages, label: '主要语言与公开显示内容' },
  ],
  catalog: [
    { icon: FileSpreadsheet, label: '项目分类、名称与多语言名称' },
    { icon: CircleDollarSign, label: '价格、时长与加项' },
    { icon: Clock3, label: '清理时间与项目缓冲' },
    { icon: Globe2, label: '是否允许顾客在线预约' },
  ],
  team: [
    { icon: UserRoundCheck, label: '员工角色与是否可接单' },
    { icon: CalendarClock, label: '个人班表、休息与请假' },
    { icon: Sparkles, label: '项目技能与轮牌规则' },
    { icon: Building2, label: '房间、床位与容量' },
  ],
  booking: [
    { icon: CalendarClock, label: '在线预约与自动确认规则' },
    { icon: ShieldCheck, label: '取消、爽约与订金规则' },
    { icon: CircleDollarSign, label: '税率、小费和折扣权限' },
    { icon: WalletCards, label: '现金或店家已有线上收款方式' },
  ],
  experience: [
    { icon: MessageSquareText, label: '预约确认、变更和到店提醒' },
    { icon: PhoneCall, label: 'AI 电话与转接设置（可选）' },
    { icon: ImagePlus, label: 'Logo、主图和店铺照片' },
    { icon: Globe2, label: '公开预约主页与品牌内容' },
  ],
  launch: [
    { icon: CheckCircle2, label: '至少一个启用项目' },
    { icon: UserRoundCheck, label: '至少一个可接单员工' },
    { icon: CalendarClock, label: '创建一笔模拟预约并检查日程' },
    { icon: CircleDollarSign, label: '模拟完成服务与结账' },
  ],
};

function ImportPanel() {
  const [selectedSource, setSelectedSource] = useState<(typeof IMPORT_SOURCES)[number]['id']>('google');
  const selected = IMPORT_SOURCES.find((source) => source.id === selectedSource)!;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold text-teal-700">最快开店方式</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">把你已经有的资料带进来</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          可以组合使用多个来源。系统会先生成一份开店草案，有冲突或不确定的内容会留给你确认，不会直接覆盖门店资料。
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {IMPORT_SOURCES.map((source) => {
          const Icon = source.icon;
          const active = source.id === selectedSource;
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => setSelectedSource(source.id)}
              className={cn(
                'rounded-2xl border p-4 text-left transition-all focus:outline-none focus:ring-2 focus:ring-teal-500/30',
                active ? 'border-teal-500 bg-teal-50/70 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300',
              )}
            >
              <div className="flex items-start gap-3">
                <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl border', source.tone)}>
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 font-bold text-slate-900">
                    {source.name}
                    {active && <CheckCircle2 className="size-4 text-teal-600" />}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-slate-600">{source.description}</span>
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-bold text-slate-900">{selected.name}</p>
            <p className="mt-1 text-sm text-slate-500">界面骨架已就绪，真实提取接口将在下一阶段接入。</p>
          </div>
          <Badge variant="warning">接口待接入</Badge>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="h-11 pl-10 text-sm"
              disabled
              placeholder={selected.id === 'website' ? 'https://你的官网.com' : selected.id === 'menu' ? '选择图片、PDF 或 Excel' : '输入店名、地址或邮编'}
            />
          </div>
          <Button disabled className="h-11 px-5">开始导入</Button>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-teal-100 bg-teal-50/50 px-4 py-3 text-sm text-teal-900">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-teal-600" />
        <p><strong>你的确认优先：</strong>每个字段都会保留来源；低置信度内容标黄，手工修改后不再被后续导入覆盖。</p>
      </div>
    </div>
  );
}

function StepFramework({ stepId }: { stepId: Exclude<SetupStepId, 'import'> }) {
  const step = SETUP_STEPS.find((item) => item.id === stepId)!;
  const Icon = step.icon;
  const checklist = STEP_CHECKLISTS[stepId];

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-teal-600 text-white shadow-sm shadow-teal-900/15">
          <Icon className="size-6" />
        </span>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-teal-700">第 {step.number} 步</p>
            <Badge variant={step.required ? 'default' : 'secondary'}>{step.required ? '开店必需' : '推荐设置'}</Badge>
          </div>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">{step.title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{step.description}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {checklist.map((item) => {
          const ItemIcon = item.icon;
          return (
            <div key={item.label} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">
                <ItemIcon className="size-4" />
              </span>
              <span className="text-sm font-medium text-slate-800">{item.label}</span>
            </div>
          );
        })}
      </div>

      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-5 py-8 text-center">
        <Sparkles className="mx-auto size-7 text-teal-600" />
        <p className="mt-3 font-bold text-slate-900">这一步的页面框架已经预留</p>
        <p className="mx-auto mt-1 max-w-lg text-sm leading-6 text-slate-500">
          下一阶段会把现有设置页和真实门店数据接进来；完成状态将由实际数据判断，不会用浏览器里的假进度。
        </p>
      </div>
    </div>
  );
}

export function SetupWizard() {
  const navigate = useNavigate();
  const { membership } = useSession();
  const { language } = useLanguage();
  const [activeStepId, setActiveStepId] = useState<SetupStepId>('import');
  const activeIndex = SETUP_STEPS.findIndex((step) => step.id === activeStepId);
  const activeStep = SETUP_STEPS[activeIndex]!;
  const storeName = membership ? pickText(membership.locationName, language) : '你的新店';
  const progress = useMemo(() => Math.round(((activeIndex + 1) / SETUP_STEPS.length) * 100), [activeIndex]);

  const goTo = (index: number) => {
    const next = SETUP_STEPS[index];
    if (next) setActiveStepId(next.id);
  };

  return (
    <div className="mx-auto max-w-[1400px] pb-10">
      <div className="mb-6 overflow-hidden rounded-3xl border border-teal-100 bg-gradient-to-r from-teal-950 via-teal-900 to-slate-900 px-6 py-6 text-white shadow-sm md:px-8">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/15">
              <Rocket className="size-6 text-teal-200" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight">准备好 {storeName}</h1>
                <Badge className="border-white/15 bg-white/10 text-white">开店设置</Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-teal-50/75">
                先把已有资料导进来，再确认项目、员工和日程。非必需项目可以跳过，之后随时回来完善。
              </p>
            </div>
          </div>
          <div className="min-w-56 rounded-2xl bg-white/10 p-4 ring-1 ring-white/10">
            <div className="flex items-center justify-between text-xs font-semibold text-teal-50/80">
              <span>当前浏览进度</span>
              <span>{activeIndex + 1} / {SETUP_STEPS.length}</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/20">
              <div className="h-full rounded-full bg-teal-300 transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-5 lg:self-start">
          <Card className="border-slate-200 bg-white p-3 shadow-sm">
            <div className="space-y-1">
              {SETUP_STEPS.map((step) => {
                const Icon = step.icon;
                const active = step.id === activeStepId;
                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => setActiveStepId(step.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500/30',
                      active ? 'bg-teal-50 text-teal-900' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                    )}
                  >
                    <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', active ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-500')}>
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{step.shortTitle}</span>
                      <span className="block text-xs text-slate-400">{step.required ? '必需' : '可跳过'}</span>
                    </span>
                    <ChevronRight className={cn('size-4', active ? 'text-teal-600' : 'text-slate-300')} />
                  </button>
                );
              })}
            </div>
            <div className="mt-3 border-t border-slate-100 px-2 pt-3">
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-800"
              >
                稍后设置，先进入后台
              </button>
            </div>
          </Card>
        </aside>

        <Card className="min-h-[640px] border-slate-200 bg-white shadow-sm">
          <div className="p-6 md:p-8">
            {activeStep.id === 'import' ? <ImportPanel /> : <StepFramework stepId={activeStep.id} />}
          </div>

          <div className="flex flex-col-reverse gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-4 sm:flex-row sm:items-center sm:justify-between md:px-8">
            <Button
              variant="ghost"
              disabled={activeIndex === 0}
              onClick={() => goTo(activeIndex - 1)}
              className="gap-2"
            >
              <ArrowLeft className="size-4" />
              上一步
            </Button>
            <div className="flex flex-col gap-2 sm:flex-row">
              {!activeStep.required && activeIndex < SETUP_STEPS.length - 1 && (
                <Button variant="ghost" onClick={() => goTo(activeIndex + 1)}>暂时跳过</Button>
              )}
              {activeIndex < SETUP_STEPS.length - 1 ? (
                <Button onClick={() => goTo(activeIndex + 1)} className="gap-2">
                  下一步
                  <ArrowRight className="size-4" />
                </Button>
              ) : (
                <Button disabled className="gap-2">
                  <Rocket className="size-4" />
                  完成检查后正式开店
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

