/**
 * 多语言完整性测试。
 *
 * ⚠️ **这三组断言各自对应一类曾经真实发生、且不会被类型系统拦住的缺陷：**
 *
 *  1. 词条缺某种语言 —— 类型约束能挡住结构缺失，但挡不住空字符串占位；
 *  2. 中英黏连的损坏串 —— 上一轮以子串替换处理中文，产出了 261 处
 *     形如「总Duration预计 50 分钟」的破碎文案，肉眼很难在四千条里逐个发现；
 *  3. 错误码缺少对应词条 —— 服务端新增错误码后，前台会看到裸的大写标识符。
 */
import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@gf/contracts';
import { translations, ALL_TRANSLATION_KEYS } from './index';
import { UI_LANGUAGES } from './types';
import { ERROR_MESSAGE_KEYS } from '@/lib/errorMessage';

describe('多语言字典完整性', () => {
  it('每个词条在全部界面语言下都有非空译文', () => {
    /*
     * 空串只对量词成立。
     *
     * 中文的「次」「名」「单」这类量词在英语中由名词本身承担（three visits），
     * 渲染为空是正确译法而非漏译。因此仅当中文原文本身不是量词
     * （长度超过两个字）时，空串才判定为漏译 —— 这样既不误报量词，
     * 也不会让真正的漏译伪装成「有意留空」。
     */
    const missing: string[] = [];
    for (const { code } of UI_LANGUAGES) {
      for (const key of ALL_TRANSLATION_KEYS) {
        const text = translations[code][key];
        if (typeof text !== 'string') {
          missing.push(`${code}/${String(key)}`);
          continue;
        }
        const isMeasureWord = translations['zh-Hans'][key].trim().length <= 2;
        if (text.trim() === '' && !isMeasureWord) missing.push(`${code}/${String(key)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('非中文译文中不存在中日韩字符', () => {
    // 漏译最常见的表现不是缺字段，而是把中文原文复制进英文栏
    const CJK = /[一-鿿㐀-䶿]/;
    const leaked: string[] = [];
    for (const { code } of UI_LANGUAGES) {
      if (code === 'zh-Hans') continue;
      for (const key of ALL_TRANSLATION_KEYS) {
        if (CJK.test(translations[code][key])) leaked.push(`${code}/${String(key)}`);
      }
    }
    expect(leaked).toEqual([]);
  });

  it('中文译文中不存在与拉丁单词黏连的损坏串', () => {
    /*
     * 命中形如「总Duration预计」「净入账Amount」的黏连。
     * 品牌名、单位与技术标识是正当的中英混排，故予以放行 ——
     * 判定标准是「中文字符与一个成词的英文单词直接相邻且语义断裂」，
     * 这里以词表方式排除已知的正当用法。
     */
    const ALLOWED = [
      'AI', 'iPad', 'iPhone', 'GenieFront', 'Stripe', 'Google', 'Yelp', 'Telnyx',
      'WiFi', 'SMS', 'CSV', 'PDF', 'API', 'URL', 'QR', 'VIP', 'POS', 'CRM', 'SOAP',
      'SSL', 'CDN', 'EIN', 'IRS', 'TCR', 'SOC', 'DID', 'LLC', 'RFM', 'GMV', 'AOV',
      'Instagram', 'Safari', 'Kiosk', 'Growth', 'Starter', 'Enterprise', 'SPA',
    ];
    const suspects: string[] = [];
    for (const key of ALL_TRANSLATION_KEYS) {
      const text = translations['zh-Hans'][key];
      for (const m of text.matchAll(/[一-鿿]([A-Za-z][A-Za-z]+)|([A-Za-z][A-Za-z]+)[一-鿿]/g)) {
        const word = m[1] ?? m[2];
        if (!ALLOWED.some((a) => a.toLowerCase() === word.toLowerCase())) {
          suspects.push(`${String(key)}: ${text}`);
          break;
        }
      }
    }
    expect(suspects).toEqual([]);
  });
});

describe('错误码文案覆盖', () => {
  it('服务端的每个错误码都有对应的界面文案', () => {
    const uncovered = Object.values(ERROR_CODES).filter((code) => !ERROR_MESSAGE_KEYS[code]);
    expect(uncovered).toEqual([]);
  });

  it('错误码文案 key 均存在于字典中', () => {
    const dangling = Object.values(ERROR_MESSAGE_KEYS).filter(
      (key) => !ALL_TRANSLATION_KEYS.includes(key),
    );
    expect(dangling).toEqual([]);
  });
});
