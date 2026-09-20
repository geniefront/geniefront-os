import { SetupSaveProvider, useSetupSave } from '@/features/setup/autosave';
import { useEntitlements } from '@/features/billing/useEntitlements';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Globe2, LogOut, Settings2, Store } from 'lucide-react';
import { pickText } from '@gf/contracts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useSession } from '@/lib/session';
import { useLanguage } from '@/LanguageContext';
import { UI_LANGUAGES, type Language } from '@/i18n/types';
import { cn } from '@/lib/utils';
import { setupStepsForPlan, type SetupStepId } from '@/features/setup/flow';
import { CatalogStepForm, LaunchStep, StoreStepForm, TeamStepForm } from '@/features/setup/StepForms';
import { DirectoryStepForm, FeaturesStepForm, RoomsStepForm } from '@/features/setup/steps';
import { useSetupReadinessQuery } from '@/features/settings/api';

/**
 * 独立开店页：不挂后台 Layout，也不提供「稍后进入后台」的绕行入口。
 * setup 状态的路由门禁在 App.tsx；这里专注于最小可营业信息。
 *
 * ⚠️ 完成度**只来自** `GET /v1/desk/setup/readiness`（S2/S5）。当前步骤是
 * 浏览位置，不代表进度；刷新 / 换设备时定位到第一个未完成步骤。
 */
export function SetupWizard() { return <SetupSaveProvider><SetupWizardContent /></SetupSaveProvider>; }

function SetupWizardContent() {
  const saveContext = useSetupSave();
  const { membership, signOut } = useSession();
  const entitlements = useEntitlements();
  const setupSteps = useMemo(() => setupStepsForPlan(entitlements.data?.plan), [entitlements.data?.plan]);
  const { language, setLanguage, t } = useLanguage();
  const { data: readiness } = useSetupReadinessQuery();

  const completeById = useMemo(() => {
    const map = new Map<SetupStepId, boolean>();
    for (const step of readiness?.steps ?? []) map.set(step.id as SetupStepId, step.complete);
    return map;
  }, [readiness]);

  const [activeStepId, setActiveStepId] = useState<SetupStepId | null>(null);
  const [stepListOpen, setStepListOpen] = useState(false);

  // 首次拿到进度时，把浏览位置落到第一个未完成的步骤（跨设备一致）。
  useEffect(() => {
    if (!entitlements.data || !readiness || setupSteps.some(step => step.id === activeStepId)) return;
    const firstIncomplete = setupSteps.find((step) => !completeById.get(step.id));
    setActiveStepId(firstIncomplete?.id ?? 'launch');
  }, [readiness, activeStepId, completeById, setupSteps, entitlements.data]);

  const activeIndex = Math.max(0, setupSteps.findIndex((step) => step.id === (activeStepId ?? 'store')));
  const activeStep = setupSteps[activeIndex]!;
  const ActiveIcon = activeStep.icon;
  const storeName = membership ? pickText(membership.locationName, language) : t('setupNewStore');

  const doneCount = setupSteps.filter((step) => completeById.get(step.id)).length;
  const progress = Math.round((doneCount / setupSteps.length) * 100);

  const goTo = async (index: number) => {
    if (!await saveContext?.flush()) return;
    const next = setupSteps[index];
    if (next) { setActiveStepId(next.id); setStepListOpen(false); }
  };
  const goToStep = (id: SetupStepId) => { void goTo(setupSteps.findIndex(step => step.id === id)); };

  const renderStep = () => {
    switch (activeStep.id) {
      case 'store': return <StoreStepForm stepNumber={activeStep.number} onSaved={() => goTo(activeIndex + 1)} />;
      case 'directory': return <DirectoryStepForm stepNumber={activeStep.number} />;
      case 'rooms': return <RoomsStepForm stepNumber={activeStep.number} onSaved={() => undefined} />;
      case 'catalog': return <CatalogStepForm stepNumber={activeStep.number} onSaved={() => undefined} />;
      case 'team': return <TeamStepForm stepNumber={activeStep.number} onSaved={() => undefined} />;
      case 'features': return <FeaturesStepForm stepNumber={activeStep.number} onSaved={() => goToStep('launch')} />;
      case 'launch': return <LaunchStep stepNumber={activeStep.number} onGoToStep={goToStep} />;
    }
  };

  if (!entitlements.data) return <div className="p-8">{t('setupReadinessLoading')}</div>;

  return (
    <div className="min-h-screen bg-[#f3faf7] text-slate-900">
      <header className="border-b border-slate-200/80 bg-white/95">
        <div className="mx-auto flex h-20 max-w-[1180px] items-center justify-between gap-4 px-5 md:px-8">
          <div className="flex items-center gap-3">
            <img src="/brand/geniefront-logo.svg" alt="GenieFront" className="h-9 w-auto" />
            <p className="hidden text-[11px] font-medium text-slate-500 sm:block">{t('setupWorkspaceLabel')}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
              <Globe2 className="size-4 text-teal-600" />
              <span className="sr-only">{t('setupLanguage')}</span>
              <select aria-label={t('setupLanguage')} value={language} onChange={(event) => setLanguage(event.target.value as Language)} className="bg-transparent font-semibold outline-none">
                {UI_LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
              </select>
            </label>
            <Button variant="ghost" size="sm" onClick={async () => { if (await saveContext?.flush()) await signOut(); }} className="gap-2 text-slate-500"><LogOut className="size-4" /><span className="hidden sm:inline">{t('setupSignOut')}</span></Button>
          </div>
        </div>
      </header>

      <div className="border-b border-slate-200/70 bg-white">
        <div className="mx-auto max-w-[1180px] px-5 py-4 md:px-8">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">{t('setupProgress')}</p>
            <p className="text-xs font-bold text-teal-700">{t('setupStepCount', { current: activeIndex + 1, total: setupSteps.length })}</p>
          </div>

          {/* 宽屏：完整步骤条 */}
          <div className="mt-3 hidden items-center sm:flex">
            {setupSteps.map((step, index) => {
              const done = completeById.get(step.id) ?? false;
              const active = index === activeIndex;
              const Icon = step.icon;
              return (
                <div key={step.id} className="flex min-w-0 flex-1 items-center">
                  <button type="button" onClick={() => goTo(index)} className={cn('group flex min-w-0 items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40')} aria-current={active ? 'step' : undefined}>
                    <span className={cn('grid size-8 shrink-0 place-items-center rounded-full border text-xs font-bold transition-colors', done ? 'border-teal-600 bg-teal-600 text-white' : active ? 'border-teal-500 bg-teal-50 text-teal-700 ring-4 ring-teal-100' : 'border-slate-300 bg-white text-slate-400')}>{done ? <Check className="size-4" /> : <Icon className="size-4" />}</span>
                    <span className={cn('hidden truncate text-xs font-bold lg:block', active ? 'text-teal-800' : done ? 'text-slate-700' : 'text-slate-400')}>{t(step.shortTitleKey)}</span>
                  </button>
                  {index < setupSteps.length - 1 && <span className={cn('mx-2 h-px flex-1', done ? 'bg-teal-500' : 'bg-slate-200')} />}
                </div>
              );
            })}
          </div>

          {/* 窄屏：第 N/7 步 + 名称 + 可展开步骤列表 */}
          <div className="mt-3 sm:hidden">
            <button type="button" onClick={() => setStepListOpen((v) => !v)} className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left">
              <span className="flex items-center gap-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-teal-50 text-xs font-bold text-teal-700"><ActiveIcon className="size-4" /></span>
                <span className="text-sm font-bold text-slate-900">{t(activeStep.shortTitleKey)}</span>
              </span>
              <span className="flex items-center gap-1 text-xs font-semibold text-slate-500">
                {t('setupStepListToggle')}
                <ChevronDown className={cn('size-4 transition-transform', stepListOpen && 'rotate-180')} />
              </span>
            </button>
            {stepListOpen && (
              <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {setupSteps.map((step, index) => {
                  const done = completeById.get(step.id) ?? false;
                  const active = index === activeIndex;
                  return (
                    <li key={step.id}>
                      <button type="button" onClick={() => goTo(index)} className={cn('flex w-full items-center justify-between gap-3 px-3 py-3 text-left', active && 'bg-teal-50/60')}>
                        <span className="flex items-center gap-2">
                          <span className={cn('grid size-6 place-items-center rounded-full text-[11px] font-bold', done ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-500')}>{done ? <Check className="size-3.5" /> : step.number}</span>
                          <span className={cn('text-sm font-semibold', active ? 'text-teal-800' : 'text-slate-700')}>{t(step.titleKey)}</span>
                        </span>
                        <span className="text-[11px] font-semibold text-slate-400">{done ? t('setupStepDone') : t('setupStepTodo')}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-500 transition-all duration-300" style={{ width: `${progress}%` }} /></div>
        </div>
      </div>

      <main className="mx-auto grid max-w-[1180px] gap-6 px-5 py-8 md:px-8 lg:grid-cols-[minmax(0,1fr)_310px] lg:py-12">
        <section>
          <div className="mb-6">
            <p className="text-sm font-bold text-teal-700">{t('setupWelcomeEyebrow')}</p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-950 md:text-4xl">{t('setupReadyStore', { storeName })}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">{t('setupIntro')}</p>
          </div>
          <Card className="overflow-hidden border-slate-200 bg-white shadow-[0_16px_50px_-28px_rgba(15,118,110,.35)]">
            <div className="border-b border-slate-100 bg-white px-6 py-5 md:px-8">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl bg-teal-50 text-teal-700"><ActiveIcon className="size-5" /></span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">{t('setupStepLabel', { number: activeStep.number })}</p>
                    <h2 className="text-xl font-extrabold text-slate-950">{t(activeStep.titleKey)}</h2>
                  </div>
                </div>
                <Badge variant={activeStep.blocksLaunch ? 'secondary' : 'default'} className="hidden sm:inline-flex">
                  {activeStep.blocksLaunch ? t('setupRequiredBadge') : t('setupOptionalBadge')}
                </Badge>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-500">{t(activeStep.descriptionKey)}</p>
            </div>
            <div className="p-6 md:p-8">{renderStep()}</div>
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-6 py-4 md:px-8">
              <Button variant="ghost" disabled={activeIndex === 0} onClick={() => goTo(activeIndex - 1)} className="gap-2"><ArrowLeft className="size-4" />{t('setupPrevious')}</Button>
              {activeIndex < setupSteps.length - 1 && <Button onClick={() => goTo(activeIndex + 1)} className="gap-2">{t('setupNext')}<ArrowRight className="size-4" /></Button>}
            </div>
          </Card>
          <p className="mt-3 text-xs leading-5 text-slate-400">{t('setupBrowseHint')}</p>
        </section>

        <aside className="space-y-4 lg:pt-14">
          <Card className="border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">{t('setupPreview')}</p>
              <Store className="size-5 text-teal-600" />
            </div>
            <div className="mt-5 rounded-2xl border border-teal-100 bg-[#f3faf7] p-5 text-center">
              <span className="mx-auto grid size-14 place-items-center rounded-full bg-white text-teal-600 shadow-sm"><Store className="size-6" /></span>
              <p className="mt-3 truncate text-base font-extrabold text-slate-900">{storeName || t('setupPreviewEmpty')}</p>
              <p className="mt-1 text-xs text-slate-500">{t('setupPreviewPrivate')}</p>
            </div>
            <div className="mt-4 space-y-2 text-sm">
              {setupSteps.map((step, index) => {
                const done = completeById.get(step.id) ?? false;
                return (
                  <button key={step.id} type="button" onClick={() => goToStep(step.id)} className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left', index === activeIndex ? 'bg-teal-50/70' : 'bg-slate-50')}>
                    <span className={cn('grid size-7 place-items-center rounded-full text-xs font-bold', done ? 'bg-teal-600 text-white' : 'bg-white text-slate-400 ring-1 ring-slate-200')}>{done ? <Check className="size-3.5" /> : index + 1}</span>
                    <span className="font-semibold text-slate-700">{t(step.shortTitleKey)}</span>
                  </button>
                );
              })}
            </div>
          </Card>
          <Card className="border-teal-100 bg-teal-950 p-5 text-white shadow-sm">
            <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-teal-300" /><div><h3 className="font-bold">{t('setupNoAccessUntilLaunch')}</h3><p className="mt-2 text-xs leading-5 text-teal-100/75">{t('setupNoAccessUntilLaunchCopy')}</p></div></div>
          </Card>
          <Card className="border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start gap-3"><Settings2 className="mt-0.5 size-5 shrink-0 text-slate-500" /><div><h3 className="font-bold text-slate-900">{t('setupAfterLaunchTitle')}</h3><p className="mt-2 text-xs leading-5 text-slate-500">{t('setupAfterLaunchCopy')}</p><div className="mt-3 flex flex-wrap gap-2"><Badge variant="secondary">{t('setupAfterLaunchWebsite')}</Badge><Badge variant="secondary">{t('setupAfterLaunchNotifications')}</Badge><Badge variant="secondary">{t('setupAfterLaunchSettings')}</Badge></div></div></div>
          </Card>
        </aside>
      </main>
    </div>
  );
}
