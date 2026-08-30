import { useState } from 'react';
import { ChevronRight, Store, Sparkles, Plus } from 'lucide-react';
import { toast } from '@heroui/react';
import { pickText } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { roleLabelKey } from '@/lib/roles';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * 门店选择页。
 *
 * 仅在账号持有多个有效 membership 时呈现；单店账号由 SessionProvider 自动选定，
 * 不经过本页 —— 单店经营者不应被暴露「组织 / 门店」这一层概念。
 */
export function LocationPicker() {
  const { t, language } = useLanguage();
  const { locations, selectMembership, signOut, loadError, reloadLocations, claimable, claimStore } = useSession();
  const [claiming, setClaiming] = useState(false);

  async function handleClaim() {
    setClaiming(true);
    try {
      await claimStore();
      toast.success(t('claimStoreSuccess'));
    } catch (err) {
      toast.danger(t('saveFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setClaiming(false);
    }
  }

  if (loadError) {
    return (
      <Card className="w-full max-w-lg">
        <EmptyState
          className="py-14"
          icon={<Store />}
          title={t('loadFailed')}
          description={loadError}
          action={<Button onClick={() => void reloadLocations()}>{t('retry')}</Button>}
        />
      </Card>
    );
  }

  return (
    <div className="w-full max-w-lg space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{t('selectLocation')}</h1>
        <p className="text-sm text-slate-500 mt-1">{t('selectLocationDesc')}</p>
      </div>

      {/* 待认领的新购门店提示卡片 */}
      {claimable && (
        <Card className="p-4 bg-teal-50/80 border-teal-200 shadow-sm animate-in fade-in duration-300">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-teal-600 text-white flex items-center justify-center shrink-0">
                <Sparkles className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-bold text-teal-700 uppercase tracking-wide">
                    {t('claimPendingStore')}
                  </p>
                </div>
                <p className="text-sm font-extrabold text-slate-900 truncate">
                  {claimable.shopName || t('setupNewStore')}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              isPending={claiming}
              className="bg-teal-600 hover:bg-teal-700 text-white rounded-lg font-semibold shrink-0"
              onClick={() => void handleClaim()}
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              {t('claimStoreAction')}
            </Button>
          </div>
        </Card>
      )}

      <div className="space-y-3">
        {locations.map((m) => (
          <Card key={m.membershipId} className="overflow-hidden transition-shadow hover:shadow-md">
            {/* 整卡可点：可点击区域与视觉可点区域保持一致，避免误触边界。 */}
            <button
              type="button"
              onClick={() => selectMembership(m.membershipId)}
              className="w-full flex items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-slate-50"
            >
              <div className="w-10 h-10 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center shrink-0">
                <Store className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-slate-900 truncate">
                    {pickText(m.locationName, language)}
                  </span>
                  {m.locationStatus === 'setup' && (
                    <Badge variant="warning">{t('setupPending')}</Badge>
                  )}
                </div>
                {m.roleKeys.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {m.roleKeys.map((role) => {
                      const labelKey = roleLabelKey(role);
                      return (
                        <span
                          key={role}
                          className="text-[11px] font-medium text-slate-500 bg-slate-100 rounded px-1.5 py-0.5"
                        >
                          {labelKey ? t(labelKey) : role}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
              <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />
            </button>
          </Card>
        ))}
      </div>

      <Button variant="ghost" className="w-full" onClick={() => void signOut()}>
        {t('signOut')}
      </Button>
    </div>
  );
}
