import { LoaderCircle } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { cn } from '@/lib/utils';

/** Visible progress without loading copy; the label remains available to screen readers. */
export function LoadingSpinner({ label, className }: { label?: string; className?: string }) {
  const { t } = useLanguage();
  return <span role="status" className={cn('inline-flex items-center justify-center text-teal-600', className)}>
    <LoaderCircle aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
    <span className="sr-only">{label ?? t('loading')}</span>
  </span>;
}
