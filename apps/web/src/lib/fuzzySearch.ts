import Fuse from 'fuse.js';

export interface FuzzySearchOptions<T> {
  /** 检索的字段列表，支持嵌套路径如 'customer.name' 或带有权重的配置 */
  keys: Array<keyof T | string | { name: string; weight: number }>;
  /** 容错阈值：0.0 为完全精确匹配，1.0 为匹配任意内容。默认 0.45（提供良好的错别字与拼写容错） */
  threshold?: number;
  /** 最小匹配字符长度 */
  minMatchCharLength?: number;
  /** 是否忽略位置 */
  ignoreLocation?: boolean;
}

/**
 * 容错模糊搜索（Typo-Tolerant Fuzzy Search）
 * 支持拼写打错字、倒序、漏字、多字、手机尾号及多字段加权搜索。
 */
export function fuzzySearch<T>(
  list: T[],
  query: string,
  options: FuzzySearchOptions<T>,
): T[] {
  const q = query?.trim();
  if (!q || !list || list.length === 0) {
    return list;
  }

  // 1. 优先尝试提取纯数字（应对手机号搜索场景，如输入 8877 匹配 (617) 555-8877）
  const digits = q.replace(/\D/g, '');

  const fuse = new Fuse(list, {
    keys: options.keys as any,
    threshold: options.threshold ?? 0.45,
    distance: 100,
    minMatchCharLength: options.minMatchCharLength ?? 1,
    ignoreLocation: options.ignoreLocation ?? true,
    shouldSort: true,
    useExtendedSearch: false,
    findAllMatches: true,
  });

  const results = fuse.search(q);
  const matched = results.map((r) => r.item);

  // 如果包含 3 位及以上纯数字但 Fuse 没有完全捕获（因格式符号），追加纯数字后置过滤
  if (digits.length >= 3) {
    const directDigitMatches = list.filter((item) => {
      if (matched.includes(item)) return false;
      const strVal = JSON.stringify(item);
      const itemDigits = strVal.replace(/\D/g, '');
      return itemDigits.includes(digits);
    });
    return [...matched, ...directDigitMatches];
  }

  return matched;
}

/**
 * 单字符串单项模糊匹配判断（用于简单 filter 场景）
 */
export function fuzzyMatch(
  text: string | null | undefined,
  query: string,
  threshold = 0.45,
): boolean {
  if (!query?.trim()) return true;
  if (!text) return false;

  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();

  // 1. 直接包含（最高优先级）
  if (t.includes(q)) return true;

  // 2. 纯数字包含
  const tDigits = t.replace(/\D/g, '');
  const qDigits = q.replace(/\D/g, '');
  if (qDigits.length >= 3 && tDigits.includes(qDigits)) return true;

  // 3. Fuse 模糊比对
  const fuse = new Fuse([{ text: t }], {
    keys: ['text'],
    threshold,
    ignoreLocation: true,
  });

  return fuse.search(q).length > 0;
}
