/**
 * 礼品卡的纯函数（批 5）。**不查库、不看时钟**（时钟由调用方传进来）。
 *
 * 这里只有三件事，但每一件都是「算错了就是钱错了」：
 *   1. 余额 = 账本求和（唯一实现）
 *   2. 一笔核销要扣多少（可能只够扣一部分）
 *   3. 提成基数按面值还是按售价（老板设的）
 */

export type CreditEntry = 'issue' | 'redeem' | 'refund' | 'adjust' | 'expire';

export interface LedgerRow {
  entry: CreditEntry;
  /** 有符号：issue/refund 为正，redeem/expire 为负 */
  amountCents: number;
}

/**
 * ⭐ 余额 = 账本求和。**唯一实现。**
 *
 * `gift_cards.balance_cents` 是这个函数结果的缓存。两者对不上时
 * 以账本为准 —— 缓存能被误改，只追加的账本不能。
 */
export function balanceOfLedger(rows: readonly LedgerRow[]): number {
  return rows.reduce((n, r) => n + r.amountCents, 0);
}

export interface RedeemPlan {
  /** 这次实际能扣多少 */
  appliedCents: number;
  /** 扣完还剩多少 */
  remainingCents: number;
  /** 这一单还差多少要用别的方式付 */
  shortfallCents: number;
}

/**
 * 一张卡对一笔金额能付多少。
 *
 * ⚠️ **不足额时付一部分，不是整笔拒绝。** 一张余额 $30 的卡遇到
 * $80 的单，正确行为是扣 $30、剩下 $50 走现金或刷卡 —— 而不是
 * 告诉客人「卡不够用」让他把卡收回去。后者在真店里会当场吵起来。
 *
 * ⚠️ 负数和零一律当 0 处理，不抛异常：这个函数在结账那一刻跑，
 * 抛异常会把整笔结账卡住，而卡余额异常不该阻断收钱。
 */
export function planRedeem(balanceCents: number, dueCents: number): RedeemPlan {
  const bal = Math.max(0, Math.floor(balanceCents));
  const due = Math.max(0, Math.floor(dueCents));
  const applied = Math.min(bal, due);
  return {
    appliedCents: applied,
    remainingCents: bal - applied,
    shortfallCents: due - applied,
  };
}

export type CommissionBasis = 'face' | 'sale';

/**
 * 用礼品卡付的那部分，技师的提成按多少钱算。
 *
 * **这是业务决定不是技术决定**，所以由老板设（`settings.gift_card.commission_basis`）：
 *
 *   · `face` —— 客人享受了 $100 的服务，技师按 $100 提。**店家吃掉折扣**
 *   · `sale` —— 店家只收到 $80，技师按 $80 提。**折扣由双方分担**
 *
 * 没有哪个更对。但选错了技师当天就会发现，所以必须让老板自己定，
 * 而不是我们替他挑一个默认值然后等他来投诉。
 *
 * @param appliedCents 这次用卡付掉的面额
 * @param faceValueCents / @param salePriceCents 整张卡的面值与售价
 */
export function commissionBaseForGiftCard(
  basis: CommissionBasis,
  appliedCents: number,
  faceValueCents: number,
  salePriceCents: number,
): number {
  if (basis === 'face') return appliedCents;
  // 按售价：这次用掉的面额占整张卡的比例，乘以他当初付的钱。
  // ⚠️ 向下取整 —— 分摊的余数留在店家这边，不能给技师多算
  if (faceValueCents <= 0) return 0;
  return Math.floor((appliedCents * salePriceCents) / faceValueCents);
}

/**
 * 卡号：22 位 Crockford base32（去掉了 I / L / O / U）。
 *
 * ⚠️ **必须传一个密码学随机源进来**，不能用 Math.random ——
 * 能猜的卡号等于把店里的钱放在门口。这里只负责编码，取随机数是调用方的事
 * （纯函数不碰 node:crypto，否则这个包在浏览器里就用不了了）。
 *
 * 22 位 × 5 bit ≈ 110 bit，穷举不现实。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeCardCode(randomBytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 22; i++) {
    out += ALPHABET[randomBytes[i % randomBytes.length]! % ALPHABET.length];
  }
  // 四位一组，前台念得出来：ABCD-EFGH-JKMN-PQRS-TV
  return out.replace(/(.{4})(?=.)/g, '$1-');
}

/** 卡号规范化：去掉分隔符、转大写。客人念的时候不会带横线 */
export function normalizeCardCode(input: string): string {
  return input.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}
