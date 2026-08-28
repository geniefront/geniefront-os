import { UserCircle, Rocket } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import type { TranslationKey } from '@/i18n';
import type { LucideIcon } from 'lucide-react';

/**
 * 还没做的页面。**不假装能用** —— 明确写「在做」，否则前台会以为是坏了。
 * 这里只保留 App.tsx 真的用到的三个；其余同名导出（Rooms/Tickets/…）
 * 早就有了真实页面，留着只会让人 import 错。
 */
function PlaceholderPage({ titleKey, icon: Icon }: { titleKey: TranslationKey; icon: LucideIcon }) {
  const { t } = useLanguage();
  return (
    <div className="h-full flex items-center justify-center">
      <Card className="max-w-md w-full shadow-sm border-slate-200">
        <EmptyState
          className="py-14"
          icon={<Icon />}
          title={
            <span className="flex items-center justify-center gap-2 text-xl font-bold text-slate-800">
              {t(titleKey)}
              <Badge variant="warning">{t('comingSoon')}</Badge>
            </span>
          }
          description={t('pageInProgress')}
        />
      </Card>
    </div>
  );
}

export const SetupWizard = () => <PlaceholderPage titleKey="setupWizard" icon={Rocket} />;
