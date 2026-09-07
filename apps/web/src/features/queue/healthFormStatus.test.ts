import { describe, expect, it } from 'vitest';
import { healthFormHonesty } from './healthFormStatus';

describe('healthFormHonesty', () => {
  it('有未签问卷时是 pending，不能画成已签署', () => {
    expect(healthFormHonesty({ pendingForms: 1 })).toBe('pending');
    expect(healthFormHonesty({ rawQueue: { pendingForms: 2 } })).toBe('pending');
  });

  it('没有待签也没有已签记录时是 none，不是「已签署合规」', () => {
    expect(healthFormHonesty({ pendingForms: 0 })).toBe('none');
    expect(healthFormHonesty({})).toBe('none');
  });

  /*
   * 这一条是本次修复的核心。此前判定读的是 healthConfirmed / completedForms，
   * 而这两个字段没有任何生产调用方会提供 —— 函数永远返回不了 signed，
   * 签过问卷的客人在入座弹窗上被写成「本店未配置电子健康问卷」。
   * 当时的单测是绿的，因为它直接喂了那两个不存在的字段。
   *
   * 现在只认服务端算好的 intakeSigned，测试也必须按真实数据形状来喂。
   */
  it('服务端标记已签齐时是 signed', () => {
    expect(healthFormHonesty({ pendingForms: 0, intakeSigned: true })).toBe('signed');
    expect(healthFormHonesty({ rawQueue: { pendingForms: 0, intakeSigned: true } })).toBe('signed');
  });

  it('已签齐但仍有待签时，待签优先 —— 少签一份就不算合规', () => {
    expect(healthFormHonesty({ pendingForms: 1, intakeSigned: true })).toBe('pending');
  });

  it('卡片上的字段优先于 rawQueue，两处不一致时以卡片为准', () => {
    expect(healthFormHonesty({ intakeSigned: true, rawQueue: { intakeSigned: false } })).toBe('signed');
    expect(healthFormHonesty({ pendingForms: 0, rawQueue: { pendingForms: 3 } })).toBe('none');
  });
});
