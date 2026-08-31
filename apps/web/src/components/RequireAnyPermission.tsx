import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLanguage } from '@/LanguageContext';
import { useCanAny } from '@/lib/permissions';
import type { TranslationKey } from '@/i18n';

export function RequireAnyPermission({
  permissions,
  titleKey = 'settings.stAccessDenied',
  descriptionKey = 'settings.stAccessDeniedDesc',
  children,
}: {
  permissions: string[];
  titleKey?: TranslationKey;
  descriptionKey?: TranslationKey;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  const allowed = useCanAny(...permissions);
  if (!allowed) {
    return (
      <div className="max-w-4xl mx-auto w-full py-16 px-4">
        <EmptyState
          icon={<ShieldAlert className="w-12 h-12 text-amber-500" />}
          title={t(titleKey)}
          description={t(descriptionKey)}
        />
      </div>
    );
  }
  return children;
}
