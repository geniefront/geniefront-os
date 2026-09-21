/**
 * 店家及员工通知的语言（邮件与短信）。
 *
 * ## 事实源
 *
 * `organizations.default_locale`。该列的写入路径只有两条：
 *
 *   1. **开户时**由 Stripe Checkout 会话的 `locale` 决定 ——
 *      即店主完成付款时那张托管页实际渲染所用的语言
 *      （`signup/checkout.ts` 与 `signup/webhook.ts`）；
 *   2. **后台设置**中的「店家通知语言」（命令 `org.setEmailLocale`）。
 *
 * ⚠️ 与 `users.locale` 是两件事：后者是**界面语言，按人存**（同一家店的
 * 前台与技师各自不同）。计费邮件的收件人是店主本人，但语言必须按组织取 ——
 * 否则店主更换设备或由他人代为设置界面语言时，账单邮件的语言会随之漂移。
 *
 * ## ⚠️ 顾客侧不适用
 *
 * 面向顾客的邮件与短信**恒为英语**，不经过本模块（`email/render.ts` 文件头）。
 */

/** 系统支持的界面语言集合，与 `staff.setLocale` 的枚举保持一致。 */
export const OWNER_LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es'] as const;

export type OwnerLocale = (typeof OWNER_LOCALES)[number];

export function isOwnerLocale(v: unknown): v is OwnerLocale {
  return typeof v === 'string' && (OWNER_LOCALES as readonly string[]).includes(v);
}

/**
 * 把任意来源的取值收敛成受支持的语言。
 *
 * ⚠️ 兜底一律为 `'en'`。语言选错的影响远小于因取值异常导致整封邮件
 * 无法生成 —— 后者会使店主完全收不到扣款失败一类的关键通知。
 */
export function ownerLocaleOf(v: unknown): OwnerLocale {
  return isOwnerLocale(v) ? v : 'en';
}

/**
 * 是否走中文分支。
 *
 * 仅用于需要区分中文格式的场景；译文由各通知文案表按完整 locale 选择。
 */
export function isZhLocale(locale: string): boolean {
  return locale.startsWith('zh');
}

/**
 * 转成 `Intl` 认得的 BCP 47 标签。
 *
 * `zh-Hans` / `zh-Hant` 本身即为合法标签，此处显式补上地区以获得稳定的
 * 日期格式（`zh-Hans` 在部分运行时下的默认地区并不确定）。
 */
export function intlLocale(locale: string): string {
  switch (locale) {
    case 'zh-Hans': return 'zh-Hans-CN';
    case 'zh-Hant': return 'zh-Hant-TW';
    default: return locale;
  }
}

// ══════════════════════════════════════════════ Stripe Checkout 页面语言

/**
 * Stripe Checkout 支持的 locale 取值（其 `locale` 参数的合法值子集）。
 * 此处只列出与本系统支持语言相关的几个。
 */
export type StripeLocale = 'en' | 'zh' | 'zh-TW' | 'zh-HK' | 'ko' | 'vi' | 'es';

/**
 * 店主语言 → Stripe Checkout 页面语言。
 *
 * ⭐ **显式下发而不是让 Stripe 用 `auto`。**
 *
 * `auto` 由浏览器语言决定页面渲染语言，但 Checkout Session 的 `locale`
 * 字段回读到的仍是字符串 `'auto'` —— 也就是说，**页面实际用了哪种语言
 * 是查不到的**。而店主邮件的语言要求与结账页保持一致，因此必须由本系统
 * 决定该语言并显式下发，再从会话对象回读，两端才可能一致。
 */
export function stripeLocaleFor(locale: OwnerLocale): StripeLocale {
  switch (locale) {
    case 'zh-Hans': return 'zh';
    case 'zh-Hant': return 'zh-TW';
    case 'ko': return 'ko';
    case 'vi': return 'vi';
    case 'es': return 'es';
    default: return 'en';
  }
}

/** Stripe Checkout 页面语言 → 店主邮件语言。无法识别时返回 null。 */
export function ownerLocaleFromStripe(v: unknown): OwnerLocale | null {
  if (typeof v !== 'string' || v === 'auto') return null;
  const tag = v.toLowerCase();
  if (tag === 'zh' || tag === 'zh-cn') return 'zh-Hans';
  if (tag === 'zh-tw' || tag === 'zh-hk') return 'zh-Hant';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('vi')) return 'vi';
  if (tag.startsWith('es')) return 'es';
  if (tag.startsWith('en')) return 'en';
  return null;
}

/**
 * 由浏览器的 `Accept-Language` 推断结账页应当使用的语言。
 *
 * ⚠️ 只做推断，**兜底恒为 `'en'`**（店主确认的默认语言）。识别不出的语言
 * 一律按英语处理，而不是挑一个「最接近」的 —— 后者会让一位只会英语的
 * 店主拿到一份西班牙语的结账页与账单邮件。
 */
export function ownerLocaleFromAcceptLanguage(header: unknown): OwnerLocale {
  if (typeof header !== 'string' || header.length === 0) return 'en';
  const tags = header.split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: (tag ?? '').trim().toLowerCase(), q: q ? Number(q.split('=')[1]) : 1 };
    })
    .filter((t) => t.tag.length > 0 && Number.isFinite(t.q) && t.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of tags) {
    if (tag === 'zh-tw' || tag === 'zh-hk' || tag === 'zh-hant'
        || tag.startsWith('zh-hant')) return 'zh-Hant';
    if (tag.startsWith('zh')) return 'zh-Hans';
    if (tag.startsWith('ko')) return 'ko';
    if (tag.startsWith('vi')) return 'vi';
    if (tag.startsWith('es')) return 'es';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}
