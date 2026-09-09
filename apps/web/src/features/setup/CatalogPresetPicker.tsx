import { useMemo, useState } from 'react';
import { toast } from '@heroui/react';
import { Sparkles } from 'lucide-react';
import { catalogPresetForBusinessType } from '@gf/contracts';
import type { CatalogPresetService } from '@gf/contracts';
import { Badge } from '@/components/ui/Badge';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { cn } from '@/lib/utils';
import { useSaveService } from '@/features/settings/api';
import { useLanguage } from '@/LanguageContext';

/** 归一化后比对：忽略大小写和首尾空白，判断某个预设项目是否已在目录里。 */
const norm = (s: string) => s.trim().toLowerCase();

/**
 * 「服务项目」步骤里的行业预设选择器（U01 / S5）。
 *
 *   · 只**预览新增项** —— 目录里已存在（按显示名归一化比对 zh-Hans / en）
 *     的预设不再展示。
 *   · 不覆盖已有项目、不改价格；勾选后逐条 `catalog.saveService` 落库，
 *     价格 / 时长按预设起步值，之后老板可在列表里改。
 *   · 重复点也不会重复建：加完一轮 `existingNames` 里就有了，下一轮自动过滤。
 */
export function CatalogPresetPicker({ businessType, existingNames, onAdded }: {
  businessType: string | null;
  existingNames: string[];
  onAdded: () => void;
}) {
  const { language, t } = useLanguage();
  const saveService = useSaveService();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const preset = catalogPresetForBusinessType(businessType);
  const existing = useMemo(() => new Set(existingNames.map(norm)), [existingNames]);

  const fresh = useMemo(() => {
    if (!preset) return [];
    return preset.services.filter((service) => {
      const names = Object.values(service.name).map(norm);
      return !names.some((n) => existing.has(n));
    });
  }, [preset, existing]);

  if (!businessType || businessType === 'mixed' || !preset) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
        {t('setupPresetNoneForType')}
      </div>
    );
  }

  const label = (service: CatalogPresetService) => service.name[language] ?? service.name.en ?? Object.values(service.name)[0] ?? '';
  const industryName = preset.name[language] ?? preset.name.en ?? '';

  const toggle = (key: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const addSelected = async () => {
    const picks = fresh.filter((service) => selected.has(service.presetKey));
    if (picks.length === 0) return;
    setAdding(true);
    let added = 0;
    try {
      // 逐条落库；预设条数很少（≤6），串行更好定位是哪一条失败。
      for (const service of picks) {
        await saveService.mutateAsync({
          name: { ...service.name },
          basePriceCents: service.basePriceCents,
          durationMin: Math.max(5, service.durationMin || 30),
          isAddon: service.isAddon ?? false,
          active: true,
        });
        added += 1;
      }
      setSelected(new Set());
      toast.success(t('setupPresetAdded', { count: added }));
      onAdded();
    } catch (error) {
      toast.danger(t('setupPresetAddFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' }));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="rounded-2xl border border-teal-100 bg-[#f3faf7] p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-teal-600" />
        <h3 className="text-sm font-bold text-slate-900">{t('setupPresetTitle', { industry: industryName })}</h3>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">{t('setupPresetIntro')}</p>

      {fresh.length === 0 ? (
        <p className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-sm text-slate-500">{t('setupPresetNothingNew')}</p>
      ) : (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {fresh.map((service) => {
              const on = selected.has(service.presetKey);
              return (
                <button
                  key={service.presetKey}
                  type="button"
                  onClick={() => toggle(service.presetKey)}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                    on ? 'border-teal-500 bg-white ring-2 ring-teal-500/20' : 'border-slate-200 bg-white/70 hover:border-teal-300',
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-slate-900">{label(service)}</span>
                      {service.isAddon && <Badge variant="secondary">{t('setupPresetAddonTag')}</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {service.durationMin > 0 && <>{service.durationMin} {t('setupMinutesUnit')} · </>}
                      ${(service.basePriceCents / 100).toFixed(2)}
                    </span>
                  </span>
                  <span className={cn('grid size-5 shrink-0 place-items-center rounded-md border text-xs', on ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300')}>
                    {on ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end">
            <GuardedButton
              permission="catalog.manage"
              onClick={addSelected}
              isDisabled={adding || selected.size === 0}
              className="gap-2"
            >
              {adding ? t('setupPresetAdding') : t('setupPresetAddSelected', { count: selected.size })}
            </GuardedButton>
          </div>
        </>
      )}
    </div>
  );
}
