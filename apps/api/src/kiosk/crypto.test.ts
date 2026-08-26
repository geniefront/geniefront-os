/**
 * 健康表加密的测试。
 *
 * 每一条都在问：**这一行没有的话，泄露的是什么？**
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  loadFormKey, encryptAnswers, decryptAnswers, keyFingerprint, ENC_ALG,
} from './crypto';

const key = randomBytes(32);
const hexKey = key.toString('hex');

const answers = {
  /*
   * ⚠️ 孕周用一个**长而独特**的数字，不是 22。
   *
   * 下面「密文里找不到明文片段」那一条是拿字节串做 `toContain`。
   * `'22'` 只有两个字节 —— 一段随机密文里恰好出现 `0x32 0x32` 的概率
   * 大约是千分之一点五，也就是说这条用例每跑几百次就会无缘无故红一次，
   * 而红的是一条写着「拖库的人拿不到明文」的安全断言。
   * 那种红比不测还糟：它教人忽略这个文件。
   *
   * 真实业务值是 22 周，用不到那么精确的探针 —— 探针要的是「独特」。
   */
  pregnant: true, pregnancy_weeks: 22, patient_ref: 'PW-22-8F3C91D6',
  conditions: ['high_blood_pressure', 'recent_surgery'],
  avoid_areas: ['lower_back'],
  note: '腰部两个月前动过手术，避开',
};

describe('密钥装载', () => {
  it('接受 64 位 hex 和 base64', () => {
    expect(loadFormKey(hexKey)).toEqual(key);
    expect(loadFormKey(key.toString('base64'))).toEqual(key);
  });

  it('⭐ 没设密钥直接报错，并告诉人怎么生成一把', () => {
    // 静默降级成明文存储是这里最坏的结果 —— 没人会发现
    expect(() => loadFormKey(undefined)).toThrow(/未设置/);
    expect(() => loadFormKey(undefined)).toThrow(/randomBytes/);
  });

  it('⭐ 短口令被拒，不会被自动拉长', () => {
    // 自动补齐会让人以为「已经加密了」，而实际强度约等于那个口令
    expect(() => loadFormKey('hunter2')).toThrow(/32 字节/);
    expect(() => loadFormKey(randomBytes(16).toString('hex'))).toThrow(/32 字节/);
  });
});

describe('加解密', () => {
  it('转一圈还是原来的答案', () => {
    expect(decryptAnswers(encryptAnswers(answers, key), key)).toEqual(answers);
  });

  it('中文与 emoji 不会被截断', () => {
    const v = { note: '腰部动过手术 🙅‍♀️ 避开 lower back' };
    expect(decryptAnswers(encryptAnswers(v, key), key)).toEqual(v);
  });

  it('⭐ 密文里找不到任何明文片段', () => {
    // 这条是整个文件的重点：拖库的人拿到的必须是解不开的字节
    const blob = encryptAnswers(answers, key);
    const asText = blob.toString('latin1');
    /*
     * ⚠️ 每一个探针都必须**足够长**。
     *
     * 这里原来有一个 `'22'`（孕周）。两个字节的串在一段随机密文里
     * 恰好撞上的概率约千分之一点五 —— 这条用例因此会周期性地无故变红
     * （2026-08-26 撞到过一次）。而它红的时候写着的是
     * 「拖库的人拿不到明文」，看到的人第一反应是加密坏了。
     *
     * 探针的作用是「明文有没有原样漏出去」，那要求它**独特**，不是**短**。
     */
    for (const leak of ['pregnant', 'high_blood_pressure', 'PW-22-8F3C91D6', '腰部两个月']) {
      expect(leak.length).toBeGreaterThanOrEqual(5);   // 太短的探针会随机误报
      expect(asText).not.toContain(leak);
    }
  });

  it('⭐ 每次加密的密文都不同 —— IV 是随机的', () => {
    // 固定 IV 的 GCM 是灾难性的：同密钥重用 IV 会泄露明文异或，还能伪造 tag。
    // 两次加同样的内容得到同样的密文，也等于泄露了「这两个客人答案一样」
    const a = encryptAnswers(answers, key);
    const b = encryptAnswers(answers, key);
    expect(a.equals(b)).toBe(false);
    expect(decryptAnswers(a, key)).toEqual(decryptAnswers(b, key));
  });

  it('⭐ 换一把钥匙解不开 —— 而不是解出一段乱码', () => {
    const blob = encryptAnswers(answers, key);
    expect(() => decryptAnswers(blob, randomBytes(32))).toThrow();
  });

  it('⭐ 密文被改一个字节就解不开（GCM 的完整性校验）', () => {
    // 「解出一段看起来像答案的乱码」比直接失败危险得多 ——
    // 技师会照着那段乱码去做，而没有人知道它是错的
    const blob = encryptAnswers(answers, key);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => decryptAnswers(tampered, key)).toThrow();
  });

  it('⭐ 改 auth tag 也解不开', () => {
    const blob = encryptAnswers(answers, key);
    const tampered = Buffer.from(blob);
    tampered[13]! ^= 0xff;   // tag 落在 12..27
    expect(() => decryptAnswers(tampered, key)).toThrow();
  });

  it('截断的密文报错，不返回半个结果', () => {
    const blob = encryptAnswers(answers, key);
    expect(() => decryptAnswers(blob.subarray(0, 10), key)).toThrow(/长度不对/);
  });

  it('空答案也能正常处理', () => {
    expect(decryptAnswers(encryptAnswers({}, key), key)).toEqual({});
  });
});

describe('密钥指纹', () => {
  it('能区分两把钥匙', () => {
    expect(keyFingerprint(key)).not.toBe(keyFingerprint(randomBytes(32)));
    expect(keyFingerprint(key)).toBe(keyFingerprint(Buffer.from(key)));
  });

  it('⭐ 短到写进日志也安全', () => {
    // 是 SHA-256 之后取前 8 位 —— 够区分，不足以还原
    const fp = keyFingerprint(key);
    expect(fp).toHaveLength(8);
    expect(key.toString('hex')).not.toContain(fp);
  });
});

describe('算法标识', () => {
  it('带版本号 —— 将来换算法时靠它区分老数据', () => {
    expect(ENC_ALG).toBe('aes-256-gcm.v1');
  });
});
