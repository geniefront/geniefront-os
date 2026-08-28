/**
 * 时间范围切换。做成一个小组件是因为几个数据页各自都有一个「今天 / 近 30 天」按钮，
 * 之前全是纯装饰 —— 点了没反应，前台会以为坏了。
 *
 * 现在它至少**改自己的标签并把选择抛出去**；页面接后端时把 onChange 里的
 * 参数带进查询即可，界面不用再动。
 */
import { useState } from 'react';
import { Calendar } from 'lucide-react';
import { Dropdown, Label } from '@heroui/react';
import { Button } from './Button';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';

export type RangeKey = 'today' | 'last7' | 'last30' | 'thisMonth';

const OPTIONS: { id: RangeKey; labelKey: TranslationKey }[] = [
  { id: 'today', labelKey: 'rangeToday' },
  { id: 'last7', labelKey: 'range7Days' },
  { id: 'last30', labelKey: 'last30Days' },
  { id: 'thisMonth', labelKey: 'rangeThisMonth' },
];

export function RangePicker({
  value, onChange, className,
}: { value: RangeKey; onChange?: (v: RangeKey) => void; className?: string }) {
  const { t } = useLanguage();
  const [internal, setInternal] = useState<RangeKey>(value);
  const current = OPTIONS.find((o) => o.id === internal) ?? OPTIONS[0]!;

  return (
    <Dropdown>
      <Button variant="outline" aria-label={t('dateRange')} className={`flex items-center gap-2 bg-white ${className ?? ''}`}>
        <Calendar className="w-4 h-4" /> {t(current.labelKey)}
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-40">
        <Dropdown.Menu
          onAction={(key) => {
            const next = String(key) as RangeKey;
            setInternal(next);
            onChange?.(next);
          }}
        >
          {OPTIONS.map((o) => (
            <Dropdown.Item key={o.id} id={o.id} textValue={t(o.labelKey)}>
              <Label>{t(o.labelKey)}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
