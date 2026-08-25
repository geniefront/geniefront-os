/**
 * 选店器（决策 10 / 02 §2）。
 *
 * 一个人可以在多家店、甚至不同老板的店有身份。只有一条就直接进，
 * 多条才出这一屏 —— 单店老板永远看不到「组织」这个概念。
 */
import { ChevronRight } from 'lucide-react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import type { LocationMembership } from '../lib/api';
import type { makeT, Locale } from '../i18n';

export function LocationPicker({
  locations, locale, t, onPick, onSignOut,
}: {
  locations: LocationMembership[];
  locale: Locale;
  t: ReturnType<typeof makeT>;
  onPick: (m: LocationMembership) => void;
  onSignOut: () => void;
}) {
  const name = (n: Record<string, string>) => n[locale] ?? n['zh-Hans'] ?? n['en'] ?? '—';

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="flex w-[min(560px,100%)] flex-col gap-5">
        <div className="flex flex-col gap-1">
          <div className="text-2xl font-extrabold tracking-[-0.03em]">{t('loc.title')}</div>
          <div className="text-xs text-ink-2">{t('loc.subtitle')}</div>
        </div>

        {locations.length === 0 && (
          <Card className="p-6 text-sm">{t('loc.none')}</Card>
        )}

        <div className="flex flex-col gap-3">
          {locations.map((m) => (
            // 整张卡可点 —— 看起来能点的区域和真的能点的区域必须一样大
            <Card key={m.membershipId} asChild>
              <button type="button" onClick={() => onPick(m)}
                      className="flex min-h-[88px] w-full cursor-pointer items-center gap-4 px-5 py-4 text-left hoverable:hover:border-ink-3/40">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-xl font-bold tracking-[-0.02em]">{name(m.locationName)}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {m.roleKeys.map((r) => (
                      <Badge key={r} tone="brand">{t(`role.${r}`)}</Badge>
                    ))}
                  </div>
                </div>
                <Badge tone="mute">{t('loc.enter')}<ChevronRight size={13} /></Badge>
              </button>
            </Card>
          ))}
        </div>

        <Button variant="ghost" onClick={onSignOut}>{t('auth.signOut')}</Button>
      </div>
    </div>
  );
}
