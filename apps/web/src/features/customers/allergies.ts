/** 客户过敏与禁忌信息的判空与呈现。 */

/**
 * 判断过敏字段是否有实质内容。
 *
 * ⚠️ 服务端的 `allergies` 是自由结构（JSONB），空值可能是 null、`{}` 或 `[]`。
 * 直接 `Boolean(x)` 会把 `{}` 判为有内容，界面上出现一个写着「{}」的
 * 过敏禁忌栏 —— 而这一栏恰恰是床边最需要可信的信息，出现噪音会让人不再看它。
 */
export function hasAllergyContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** 过敏信息的可读呈现。结构化内容展开为「键：值」，避免直接抛出 JSON。 */
export function formatAllergies(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join('、');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== '' && v !== false)
      .map(([k, v]) => (v === true ? k : `${k}：${String(v)}`))
      .join('、');
  }
  return String(value);
}
