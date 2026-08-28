import { ShieldAlert } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * 账号无有效门店身份时的终止页。
 *
 * 触发条件：账号已通过认证，但 `/v1/me/locations` 返回空集合 —— 通常为
 * 尚未认领门店、已离职，或门店被停用。此处不提供任何自助恢复入口，
 * 权限授予必须由门店管理员在服务端完成。
 */
export function NoMembership() {
  const { t } = useLanguage();
  const { signOut, reloadLocations } = useSession();

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
