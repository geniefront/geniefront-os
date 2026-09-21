import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ results: [] as any[] }));
vi.mock('@/features/schedule/api', async importOriginal => ({ ...await importOriginal<object>(), useDayRange: () => state.results }));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
import { useWeekItems } from './ScheduleContext';
it('keeps failed and loading days distinct from successful empty days', () => {
  const retry = vi.fn();
  state.results = [
    { isPending: true, isPlaceholderData: false, error: null, refetch: retry },
    { isPending: false, error: new Error('500'), refetch: retry },
    { isPending: false, error: null, refetch: retry, data: { businessDate: '2026-09-22', services: [], items: [] } },
  ];
  const { result } = renderHook(() => useWeekItems(['2026-09-20', '2026-09-21', '2026-09-22']));
  expect(result.current.itemsByDate.has('2026-09-20')).toBe(false);
  expect(result.current.days[0]?.isLoading).toBe(true);
  expect(result.current.days[1]?.error).toBeInstanceOf(Error);
  expect(result.current.itemsByDate.get('2026-09-22')).toEqual([]);
  result.current.days[1]?.retry();
  expect(retry).toHaveBeenCalledOnce();
});
