import { Lock } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';

/**
 * 只读提示条。
 *
 * 用于「这一页你能看，但不能改」的场景。单独把按钮置灰是不够的：
 * 一屏十几个灰按钮不会被读成「我没权限」，只会被读成「系统坏了」或者
 * 「还没加载完」。要在页面顶部先说清楚这一句，下面的灰才有解释。
 *
 * ⚠️ 这是**说明**，不是权限判定。判定在服务端（命令总线），
 * 界面这一层只负责别让人对着一个注定 403 的按钮反复点。
 */
export function ReadOnlyNotice({ what }: { what?: string }) {
  const { t } = useLanguage();
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
      <p className="font-medium">
        {what ?? t('readOnlyNotice')}
        <span className="ml-1.5 font-normal text-amber-800">{t('readOnlyNoticeHint')}</span>
      </p>
    </div>
  );
}
