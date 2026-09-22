import {customerBookingSms} from './booking';
/**
 * 客户短信文案。**纯函数** —— 不查库、不看时钟(和 email/render.ts 同一条纪律)。
 *
 * ## 客户侧恒为英文；店家侧由 sms/booking.ts 按通知语言渲染。
 *
 * 邮件是多语言的,短信不是。两个理由:
 *
 *   1. **客群是美国人。** 这是店主对自己客户的判断,不是我们猜的
 *   2. ⚠️ **非 GSM 字符会让整条短信的容量从 160 掉到 70**（`segments.ts`）。
 *      一个中文店名就能让每条从 1 段变 2–3 段 —— 成本翻倍,而客人
 *      看到的完全一样。多语言短信要么接受这个成本,要么就别做
 *
 * 所以下面每一条模板都必须落在 **GSM-7 且 ≤160 字符**里,
 * 有测试盯着(`sms.test.ts`)。
 *
 * ## 🔴 一个字都不许提「回复 CANCEL」
 *
 * CANCEL 是运营商强制的**退订**关键词(`keywords.ts` 那段长注释)。
 * 在预约短信里写「reply CANCEL to cancel」= 亲手教客人退订,
 * 而他以为自己取消了预约。改期一律引导打电话。
 */

/**
 * 店名 —— **强制全英文**（店主 2026-08-22 定）。
 *
 * ⚠️ 不跟界面语言走：`莲花美甲` 会把整条短信推进 UCS-2，70 字符一段，
 * 成本翻倍而客人看到的完全一样（`segments.ts`）。
 *
 * ## 四级回退，一级比一级差，但**每一级都比上一级安全**
 *
 * ```
 * name.en            「Lotus Nails & Spa」   最好
 * 别的语言剥成 ASCII  「莲花美甲 Lotus」→「Lotus」  还能认
 * slug 还原           「lotus-nails」→「Lotus Nails」 ⭐ 见下
 * 'Salon'                                    最后的兜底
 * ```
 *
 * ⭐ **第三级（slug）是有意加的。** 一家只填了中文店名的店，
 * 前两级都会落空，客人收到的就是一条署名「Salon」的短信 ——
 * 那看起来就是诈骗短信，而且这行最不缺的就是把陌生短信当诈骗的客人。
 *
 * 而 `locations.slug` **一定是 ASCII**（建店时从店名转的，
 * `sql/0030` 里那段 regexp_replace），把连字符还原成空格再首字母大写，
 * 「lotus-nails」就变回「Lotus Nails」。同一家店拿到的永远是同一个名字。
 */
export function smsShopName(name: unknown, slug?: string | null, fallback = 'Salon'): string {
  const o = (name ?? {}) as Record<string, string>;
  const clean = (v: string) =>
    v.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();

  const en = typeof name === 'string' ? clean(name) : clean(o['en'] ?? '');
  if (en) return en.slice(0, 24);

  const other = clean(Object.values(o).find((v) => clean(v)) ?? '');
  if (other) return other.slice(0, 24);

  const fromSlug = (slug ?? '')
    // 建店时 slug 末尾会缀一段随机 hex 防重（sql/0030）——那是给 URL 用的，
    // 不该出现在客人看到的署名里
    .replace(/-[0-9a-f]{6,}$/i, '')
    .split('-').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  if (fromSlug) return clean(fromSlug).slice(0, 24);

  return fallback;
}

/**
 * ⭐ 短信的署名。**所有门店共用一个** —— 发送号是平台号，
 * 10DLC 注册的品牌也是它（见 `renderConfirmSms` 上方那段）。
 */
export const SENDER = 'GenieFront';

/**
 * 退订说明。CTIA 要求至少出现在第一条中；本系统**每条都带** ——
 * 一年到店两次的顾客不会记得自己订阅过什么。
 */
export const OPT_OUT_NOTICE = 'Reply STOP to opt out.';

/** 美式电话显示:+16175550142 → (617) 555-0142。给客人看的号要能直接念 */
export function prettyPhone(e164: string | null): string | null {
  if (!e164) return null;
  const d = e164.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (ten.length !== 10) return e164;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

export interface ConfirmSms {
  shopName: unknown;
  /** 店名全是非 ASCII 时的回退来源。`locations.slug` 一定是 ASCII */
  shopSlug?: string | null;
  serviceName: string;
  /** 已按门店时区格式化好,如 `Wed Aug 26, 12:30 PM` */
  whenText: string;
  shopPhone: string | null;
  /**
   * Legacy argument accepted for compatibility; customer SMS never includes links.
   */
  manageUrl?: string | null;
  hasEmail?: boolean|undefined;
  preferredStaff?: string|undefined;
}

/** Transactional receipt shared by web and voice bookings. Customer management
 * links stay in email; SMS uses one segment and directs the customer to call store. */
export function renderConfirmSms(d: ConfirmSms): string {
  return customerBookingSms({event:'confirmed',shopPhone:d.shopPhone,shop:smsShopName(d.shopName,d.shopSlug??null,'Your store'),service:d.serviceName,when:d.whenText,hasEmail:d.hasEmail,preferredStaff:d.preferredStaff});
}

/**
 * HELP 回复。CTIA 要求必须答,而且必须说清「是谁、发什么、怎么退、资费」。
 *
 * ⚠️ 这一条是**我们**回的,不是店家 —— 客人回的是平台号(docs/09 §5.1)。
 * 所以署名是 GenieFront,不是某一家店。
 */
export function renderHelpSms(): string {
  return `${SENDER}: appointment confirmations for your salon. `
    + `Msg&data rates may apply. ${OPT_OUT_NOTICE} Help: support@geniefront.com`;
}


/**
 * 给任意一条外发短信补齐**品牌署名**与**退订说明**。
 *
 * ## 为什么自由文本也必须补
 *
 * 前台手打的短信（`sms.sendDirect` / `customer.sendSms`）此前既无署名也无
 * 退订说明。两者都不是可选项：
 *
 *   · **署名**：发送号为平台号，10DLC 注册品牌是 GenieFront。收件人无法
 *     由号码识别发送方时，该消息在运营商侧更易被判定为欺骗性流量；
 *   · **退订说明**：退订是平台级行为，缺失即构成合规缺陷。
 *
 * ⚠️ 已包含时不重复添加 —— 模板类短信（`renderConfirmSms` 等）自身已带。
 */
export function withComplianceFooter(body: string): string {
  let out = body.trim();
  if (!out.startsWith(`${SENDER}:`)) out = `${SENDER}: ${out}`;
  if (!/reply\s+stop/i.test(out)) out = `${out} ${OPT_OUT_NOTICE}`;
  return out;
}
