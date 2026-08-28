import { FlaskConical } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';

/**
 * 未接入真实数据的页面横幅。
 *
 * ⚠️ 存在的理由：一张画得很像真数据的仪表盘，会被门店用来做经营判断。
 * 本轮已经发生过一次类似情况 —— 测试残留数据被当作真实数据讨论。
 * 因此凡是尚未接入服务端的页面，必须在页面顶部显式声明，
 * 而不是依赖阅读者自己记得哪几页还是假的。
 *
 * 该页接入真实数据后，删除此组件的引用即可。
 */
export function SampleDataNotice() {
  const { t } = useLanguage();
  return (
    <div
      role="note"
      className="flex items-start gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900"
    >
      <FlaskConical className="w-4 h-4 mt-0.5 shrink-0" />
      <p className="text-xs font-medium leading-relaxed">
        <span className="font-bold">{t('sampleDataBadge')}</span>
        {' · '}
        {t('sampleDataNotice')}
      </p>
    </div>
  );
}
