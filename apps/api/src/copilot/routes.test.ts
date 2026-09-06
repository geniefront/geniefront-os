/**
 * 副驾路由的两条不变式。
 *
 * 这两条都是为了守住同一个曾经出过事的 bug：**同一个方案被执行两次**。
 * 早先返回方案时会顺手签发一枚 legacy proposalToken，于是「走 token 执行
 * 第 0 步」和「走 task 执行整批」两条路并存，前者还不回写任务状态，
 * 前台点两下就建两次单。
 */

import { describe, expect, it } from 'vitest';
import { getCommand } from '@gf/contracts';
import { UNDO_COMMANDS, summariseRevisionForHistory } from './routes';

describe('UNDO_COMMANDS', () => {
  it('⭐ 白名单本身要保持极小，且每一项都是已注册命令', () => {
    // 白名单在这里写死一份。任何人往 routes.ts 里加一项，这条就会红 ——
    // 逼他解释为什么那条命令可以绕过有锁的 task 执行通道。
    expect([...UNDO_COMMANDS].sort()).toEqual(['appointment.cancel']);
    for (const command of UNDO_COMMANDS) {
      expect(getCommand(command), `${command} 不是一个已注册的命令`).toBeTruthy();
    }
  });

  it('绝不包含建单、改期、收款、发信这类正向命令', () => {
    for (const forward of [
      'appointment.create',
      'appointment.createBatch',
      'appointment.reschedule',
      'ticket.open',
      'ticket.pay',
      'sms.sendDirect',
      'form.share',
      'queue.join',
      'resource.setStatus',
    ]) {
      expect(UNDO_COMMANDS.has(forward)).toBe(false);
    }
  });
});

describe('summariseRevisionForHistory', () => {
  const step = (command: string, summary: string) => ({ command, summary });

  it('单步方案原样带命令名与摘要', () => {
    expect(summariseRevisionForHistory({
      title: '把 3 号房设为清洁',
      steps: [step('resource.setStatus', '将房间 3 标记为打扫中')],
    })).toEqual({ command: 'resource.setStatus', summary: '将房间 3 标记为打扫中' });
  });

  it('⭐ 多步方案折叠成标题 + 步数，不会只剩第一步', () => {
    const out = summariseRevisionForHistory({
      title: '导入 3 条外部预约',
      steps: [
        step('appointment.create', '导入 Lisa 18:00 Gel Manicure'),
        step('appointment.create', '导入 Amy 19:00 Pedicure'),
        step('appointment.create', '导入 Kim 20:00 Deep Tissue'),
      ],
    });
    expect(out?.summary).toBe('导入 3 条外部预约');
    expect(out?.command).toContain('3 项');
  });

  it('⭐ 摘要里不含任何可执行令牌 —— 会话历史不是执行通道', () => {
    const out = summariseRevisionForHistory({
      title: 'x',
      steps: [step('appointment.create', 'y')],
    });
    expect(JSON.stringify(out)).not.toMatch(/token/i);
  });

  it('空方案返回 null', () => {
    expect(summariseRevisionForHistory(null)).toBeNull();
    expect(summariseRevisionForHistory({ title: 'x', steps: [] })).toBeNull();
  });
});
