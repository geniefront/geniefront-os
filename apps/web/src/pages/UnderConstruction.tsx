import { useNavigate } from 'react-router-dom';
import { Construction } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { TranslationKey } from '@/i18n';

/**
 * 未开放模块的统一占位页。
 *
 * 设计意图：对尚未交付的模块给出明确、一致的状态说明，避免用户将其误判为
 * 系统故障或权限缺失。该页不提供任何可交互的业务入口，仅保留返回路径。
 *
 * 模块开放时，将 `App.tsx` 中对应路由指回真实页面组件即可，本页无需修改。
 */
export function UnderConstruction({ titleKey }: { titleKey: TranslationKey }) {
  const { t } = useLanguage();
  const navigate = useNavigate();

  return (
    <div className="h-full flex items-center justify-center">
      <Card className="max-w-lg w-full shadow-sm border-slate-200">
        <EmptyState
          className="py-16"
          icon={<Construction />}
          title={
            <span className="flex items-center justify-center gap-2 text-xl font-bold text-slate-800">
              {t(titleKey)}
              <Badge variant="warning">{t('underConstruction')}</Badge>
            </span>
          }
          description={t('underConstructionDesc')}
          action={
            <Button variant="outline" onClick={() => navigate('/dashboard')}>
              {t('backToDashboard')}
            </Button>
          }
        />
      </Card>
    </div>
  );
}
