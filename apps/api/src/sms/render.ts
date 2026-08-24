/**
 * 短信文案。**纯函数** —— 不查库、不看时钟(和 email/render.ts 同一条纪律)。
 *
 * ## ⭐ 全英文,不做多语言(2026-08-22 店主定)
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
  confirmationCode: string | null;
  shopPhone: string | null;
}

/**
 * 预约确认。
 *
 * 结构是刻意的:**署名开头**(客人一眼知道谁发的,不然像诈骗短信)、
 * 在哪家店、时间和项目、确认码、改期打电话、退订说明。
 *
 * ## ⭐ 署名是 GenieFront,不是店名（2026-08-24 店主定）
 *
 * 以前这条短信开头是店名（`Golden Foot Spa: You're booked…`）。改掉的理由
 * 不只是品牌:
 *
 *   · **发送号是平台号**（`TELNYX_SMS_FROM`,一个号服务所有门店,docs/09 §5.1）。
 *     署名店名而号码是平台的,客人存下的号和店里的号对不上 ——
 *     下次店里发来的东西反而像陌生号
 *   · **10DLC 注册的品牌是 GenieFront**,不是每一家店。冒用店名署名,
 *     在运营商眼里是「发送者身份与注册品牌不符」,这一类最容易被判成
 *     欺骗性流量，整条通道会被掐（而不是只掐这一条）
 *   · 退订也是平台级的（客人回 STOP 是对我们说的,不是对某一家店）——
 *     署名和退订对象不一致本身就是矛盾的
 *
 * 所以现在是：`GenieFront: You're booked at <店名> for <项目> on <时间>…`
 * 店名仍然出现在句子里，客人照样一眼知道是哪家店。
 *
 * 退订说明按 CTIA 要求至少出现在第一条里。我们每条都带 ——
 * 一年来两次的客人不会记得自己订阅过什么。
 */
export function renderConfirmSms(d: ConfirmSms): string {
  const fullShop = smsShopName(d.shopName, d.shopSlug ?? null, '');
  const phone = prettyPhone(d.shopPhone);
  const code = d.confirmationCode ? ` Code ${d.confirmationCode}.` : '';
  const call = phone ? ` To change call ${phone}.` : ' Call the salon to change.';
  const build = (service: string, shop: string) => {
    // 店名一个字都拼不出来时（连 slug 都没有）就不写「at …」——
    // 「booked at Salon」比不写还糟，它看起来像模板没渲染出来
    const at = shop ? ` at ${shop} -` : '';
    /*
     * ⚠️ 措辞抠到这个程度是有原因的：署名从店名换成 `GenieFront:` 之后，
     * 固定部分多了 13 个字符 —— 「Golden Foot Spa + Deep Tissue 90min」
     * 这种**最常见**的组合当场从 158 涨到 171，两个名字都要被砍。
     * 「You're booked at X for Y on Z」→「Booked at X - Y, Z」省下 11 个，
     * 常见的那条落在 150 上下，谁都不用砍。
     */
    return `${SENDER}: Booked${at} ${service}, ${d.whenText}.${code}${call}`
      + ' Reply STOP to opt out.';
  };

  /**
   * ⭐ 挤进一段。
   *
   * 「Golden Lotus Nails and Day Spa」+「Deluxe Spa Pedicure with Callus
   * Treatment」= 两段。客人看到的完全一样,账单翻倍,而且是**每一条都翻**
   * ——这种成本不会有人来投诉,只会在月底的数字里。
   *
   * 砍的顺序是**项目名 → 店名**，电话和退订说明一个字都不动：
   *
   *   · 电话砍了他就没法改期——那正是这条短信的作用
   *   · 项目名砍成「Deluxe Spa Pedicure with…」他照样知道自己订了什么
   *   · ⭐ 店名以前是不砍的（砍了认不出谁发的）。2026-08-24 署名改成
   *     GenieFront 之后这条不成立了：**身份锚点是署名，不是店名**，
   *     所以店名可以退让 —— 但留够 12 个字符，「Golden Lo」认不出是哪家店
   *
   * ⚠️ 两级都砍到底还超，就老实发两段：省一段钱换一个看不懂的通知是笔烂账。
   */
  const MIN_SERVICE = 16;
  const MIN_SHOP = 12;

  let service = d.serviceName.trim();
  let shop = fullShop;

  const overBy = () => build(service, shop).length - 160;

  let over = overBy();
  if (over > 0) {
    // 一次算准该砍多少：超出的长度 + 3 个点。砍不到 MIN_SERVICE 以下
    const keep = Math.max(MIN_SERVICE, service.length - over - 3);
    if (keep < service.length) service = `${service.slice(0, keep).trimEnd()}...`;
  }

  over = overBy();
  if (over > 0 && shop.length > MIN_SHOP) {
    shop = shop.slice(0, Math.max(MIN_SHOP, shop.length - over)).trimEnd();
  }

  return build(service, shop);
}

/**
 * HELP 回复。CTIA 要求必须答,而且必须说清「是谁、发什么、怎么退、资费」。
 *
 * ⚠️ 这一条是**我们**回的,不是店家 —— 客人回的是平台号(docs/09 §5.1)。
 * 所以署名是 GenieFront,不是某一家店。
 */
export function renderHelpSms(): string {
  return `${SENDER}: appointment confirmations for your salon. `
    + 'Msg&data rates may apply. Reply STOP to opt out. Help: support@geniefront.com';
}
