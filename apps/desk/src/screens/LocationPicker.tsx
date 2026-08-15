/**
 * 选店器（决策 10 / 02 §2）。
 *
 * 一个人可以在多家店、甚至不同老板的店有身份。只有一条就直接进，
 * 多条才出这一屏 —— 单店老板永远看不到「组织」这个概念。
 */
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
    <div className="center-page">
      <div className="stack" style={{ width: 'min(560px, 100%)', gap: 18 }}>
        <div className="stack" style={{ gap: 4 }}>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800 }}>{t('loc.title')}</div>
          <div className="muted">{t('loc.subtitle')}</div>
        </div>

        {locations.length === 0 && (
          <div className="card" style={{ padding: 24 }}>{t('loc.none')}</div>
        )}

        <div className="stack">
          {locations.map((m) => (
            <button key={m.membershipId} className="card row" onClick={() => onPick(m)}
                    style={{ minHeight: 88, padding: '16px 20px', textAlign: 'left',
                             cursor: 'pointer', gap: 16 }}>
              <div className="grow stack" style={{ gap: 6 }}>
                <span style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }}>
                  {name(m.locationName)}
                </span>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {m.roleKeys.map((r) => (
                    <span key={r} className="badge badge-soft">{t(`role.${r}`)}</span>
                  ))}
                </div>
              </div>
              <span className="badge badge-mute">{t('loc.enter')} ›</span>
            </button>
          ))}
        </div>

        <button className="btn btn-ghost" onClick={onSignOut}>{t('auth.signOut')}</button>
      </div>
    </div>
  );
}
