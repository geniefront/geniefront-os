/**
 * 顾客姓名在头像、徽章上的呈现。
 *
 * 门店常见写法是「王明 (Wang Ming)」：空格切开会把括号当成第二个词，
 * 头像变成「王(」。电话被拼进姓名时，看板还会谎称「散客无电话」。
 */

export function customerInitials(name: string): string {
  const stripped = name.replace(/\s*\([^)]*\)/g, '').trim();
  if (!stripped) return '?';

  const cjk = stripped.replace(/[^\u3400-\u9fff]/g, '');
  if (cjk.length >= 1) return cjk.slice(0, 2);

  const parts = stripped.split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .filter((ch): ch is string => Boolean(ch));
  return letters.join('') || '?';
}

export function walkInShowsNoPhone(input: {
  phone?: string | null;
  customerName: string;
}): boolean {
  const phoneDigits = (input.phone ?? '').replace(/\D/g, '');
  if (phoneDigits.length >= 7) return false;
  const nameDigits = input.customerName.replace(/\D/g, '');
  if (nameDigits.length >= 7) return false;
  return true;
}
