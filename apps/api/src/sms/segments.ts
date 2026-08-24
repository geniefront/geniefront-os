/**
 * 短信分段计数（GSM 03.38）。**纯函数**，计费的唯一依据。
 *
 * ## 为什么必须按 segment 算而不是按条
 *
 * 运营商按 **segment** 收钱,不按「条」。一条 200 字符的英文短信客人看到的是
 * 一条,账单上是**两段**。按条记账会低估 —— 而低估的方向永远是我们贴钱。
 *
 * ## 两套编码,门槛差一倍多
 *
 * | | 单条上限 | 拼接时每段 |
 * | :--- | ---: | ---: |
 * | GSM-7（纯英文/常见符号） | 160 | 153 |
 * | UCS-2（出现任何一个非 GSM 字符） | 70 | 67 |
 *
 * ⚠️ **一个字符就能让整条翻倍。** 一个中文店名、一个花引号 `’`、
 * 一个 emoji —— 整条立刻从 160 掉到 70。所以模板里的店名强制取英文名
 * （`sms/render.ts` 里那一行有说明),而不是让它跟界面语言走。
 *
 * ⚠️ 拼接短信的每段要留 6 字节的 UDH 头,所以是 153 而不是 160。
 * 少算这一步的表现是:刚好 160–161 字符的模板在账单上比预期贵一倍。
 */

/** GSM 03.38 基本字符集。不在这里、也不在扩展表里的 → 整条转 UCS-2 */
const GSM_BASIC = new Set(
  ('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
   + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà').split(''),
);

/** 扩展表:这些字符能用 GSM-7 表示,但**各占两个 septet**（转义符 + 本体） */
const GSM_EXT = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export interface SmsSize {
  encoding: 'GSM-7' | 'UCS-2';
  /** GSM-7 下是 septet 数(扩展字符算 2),UCS-2 下是 UTF-16 码元数 */
  units: number;
  segments: number;
}

export function measure(text: string): SmsSize {
  let septets = 0;
  let gsm = true;

  for (const ch of text) {
    if (GSM_EXT.has(ch)) { septets += 2; continue; }
    if (GSM_BASIC.has(ch)) { septets += 1; continue; }
    gsm = false;
    break;
  }

  if (gsm) {
    const segments = septets <= 160 ? Math.max(1, Math.ceil(septets / 160))
      : Math.ceil(septets / 153);
    return { encoding: 'GSM-7', units: septets, segments };
  }

  /**
   * UCS-2 按 **UTF-16 码元**算,不是按「字符」。
   *
   * emoji 和部分中日韩生僻字是**代理对**,占两个码元 —— `[...text].length`
   * 会把它算成 1,于是一条塞满 emoji 的短信实际长度是我们算出来的两倍。
   * `text.length` 在 JS 里恰好就是 UTF-16 码元数,这里要的正是它。
   */
  const units = text.length;
  const segments = units <= 70 ? Math.max(1, Math.ceil(units / 70)) : Math.ceil(units / 67);
  return { encoding: 'UCS-2', units, segments };
}

export const segmentsOf = (text: string): number => measure(text).segments;
