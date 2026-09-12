import type { HealthAiSummary } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';

export function HealthSummary({ summary }: { summary: HealthAiSummary }) {
  const { language, t } = useLanguage();
  const locale = language as keyof typeof summary.headline;
  return <div className="space-y-2 text-sm leading-relaxed">
    <p className="font-semibold">{summary.headline[locale] ?? summary.headline.en}</p>
    <ul className="list-disc space-y-1 pl-5">{(summary.keyAlerts[locale] ?? summary.keyAlerts.en).map((line) => <li key={line}>{line}</li>)}</ul>
    {(summary.avoidAreasList[locale] ?? summary.avoidAreasList.en).length > 0 && <p className="font-semibold">{t('queue.quSummaryAvoid')}: {(summary.avoidAreasList[locale] ?? summary.avoidAreasList.en).join(' · ')}</p>}
    <p>{summary.focusNotes[locale] ?? summary.focusNotes.en}</p>
    <p className="text-xs">{summary.technicianAdvice[locale] ?? summary.technicianAdvice.en}</p>
  </div>;
}
