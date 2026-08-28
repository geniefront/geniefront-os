import { QueryClient } from '@tanstack/react-query';

/**
 * 前台的默认取数策略。门店的网不稳，页面又常年开着不刷新：
 * 窗口重新聚焦时重取（前台切回浏览器就该看到最新的），
 * 失败重试一次就够 —— 再多只是让她多等，而不是更可能成功。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});
