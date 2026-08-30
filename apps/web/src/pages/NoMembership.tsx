import { useState } from 'react';
import { ShieldAlert, Store, Sparkles, ArrowRight } from 'lucide-react';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * 账号无有效门店身份时的处理页。
 *
 * 两种情况：
 * 1. 账号存在待认领开通的已付费门店（claimable）：提供一键开通入口，完成后直接进入开店向导。
 * 2. 账号确实无任何关联门店：呈现终止提示，引导联系管理员。
 */
export function NoMembership() {
  const { t } = useLanguage();
  const { signOut, reloadLocations, claimable, claimStore } = useSession();
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

  if (claimable) {
    return (
      <Card className="w-full max-w-lg p-8 border-slate-200 shadow-xl shadow-slate-200/50 rounded-2xl animate-in fade-in duration-300">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-teal-50 text-teal-600 flex items-center justify-center mx-auto mb-3 shadow-sm">
            <Store className="w-6 h-6" />
          </div>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-teal-50 text-teal-700 text-xs font-bold mb-2">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('claimPendingStore')}</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight mb-2">
            {claimable.shopName || t('setupNewStore')}
          </h1>
          <p className="text-xs text-slate-500 leading-relaxed max-w-sm mx-auto">
            {t('claimPendingStoreDesc')}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-teal-600 text-white flex items-center justify-center font-bold text-sm">
              GF
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900">{claimable.shopName || t('setupNewStore')}</p>
              <p className="text-xs text-slate-500 capitalize">{claimable.plan} Plan</p>
            </div>
          </div>
          <Badge variant="warning">{t('setupPending')}</Badge>
        </div>

        <div className="space-y-3">
          <Button
            type="button"
            isPending={claiming}
            className="w-full bg-teal-600 hover:bg-teal-700 text-white rounded-xl shadow-md h-12 text-sm font-semibold transition-all hover:shadow-lg hover:-translate-y-0.5 flex items-center justify-center gap-2"
            onClick={() => void handleClaim()}
          >
            <span>{t('claimStoreAction')}</span>
            <ArrowRight className="w-4 h-4" />
          </Button>

          <Button variant="ghost" className="w-full" onClick={() => void signOut()}>
            {t('signOut')}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-lg">
      <EmptyState
        className="py-14"
        icon={<ShieldAlert />}
        title={t('noMembership')}
        description={t('noMembershipDesc')}
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void reloadLocations()}>{t('retry')}</Button>
            <Button variant="secondary" onClick={() => void signOut()}>{t('signOut')}</Button>
          </div>
        }
      />
    </Card>
  );
}
