import { describe, expect, it } from 'vitest';
import { COMMAND_REGISTRY, aiToolDefinitions, commandCatalogTextForPermissions } from './registry';

describe('copilot command catalog policy', () => {
  it('requires confirmation for every exposed side-effecting command', () => {
    expect(aiToolDefinitions().filter((command) => command.confirm === 'never')).toEqual([]);
  });

  it('filters by caller permission and excludes admin-console commands', () => {
    const catalog = commandCatalogTextForPermissions(new Set([
      'appointment.read', 'appointment.write', 'appointment.cancel',
    ]));
    expect(catalog).toContain('appointment.create');
    expect(catalog).toContain('appointment.cancel');
    expect(catalog).not.toContain('ticket.pay');
    expect(catalog).not.toContain('billing.setAutoTopup');
    expect(catalog).not.toContain('location.saveProfile');
  });
});

/**
 * 注册表完整性。
 *
 * `defineCommand` 只是造出一个对象 —— 命令要能被调用，还必须出现在本模块
 * 汇总的那几个 `*_COMMANDS` 数组里。漏掉的后果是**没有任何编译期错误**：
 * 定义在、handler 在、前端调用点的类型也对，只有路由不存在，
 * 表现为线上 404。`staff.recordDirectCashTip` 就是这样漏了一整条技师现金
 * 小费录入功能，直到权限对账脚本把它挑出来。
 */
describe('命令注册表完整性', () => {
  it('每个 defineCommand 出来的命令都必须进注册表', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');

    const dir = fileURLToPath(new URL('./commands', import.meta.url));
    const defined = new Map<string, string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      const src = readFileSync(`${dir}/${file}`, 'utf8');
      for (const m of src.matchAll(/defineCommand\(\{\s*name:\s*'([^']+)'/g)) defined.set(m[1]!, file);
    }

    // 起步先确认扫描本身有效：扫不到任何命令的话，这条测试会变成永远通过
    expect(defined.size).toBeGreaterThan(100);

    const missing = [...defined].filter(([name]) => !COMMAND_REGISTRY.has(name));
    expect(missing.map(([name, file]) => `${name}（${file}）`)).toEqual([]);
  });
});
