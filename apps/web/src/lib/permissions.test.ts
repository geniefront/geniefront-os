/**
 * 界面权限标识的有效性测试。
 *
 * ⚠️ **权限标识写错不会有任何报错，只会让按钮永远不出现。**
 * `useCan()` 刻意接受 `string` 而非联合类型（见 `permissions.ts` 的说明：
 * 服务端新增权限时前端不应编译失败，未知权限返回 false 是安全的降级方向）。
 * 该设计的代价是拼写错误会被静默吞掉 —— `ticket.discout` 与
 * `ticket.discount` 的区别，在界面上表现为「这个按钮怎么一直是灰的」，
 * 而门店只会认为自己没有权限。
 *
 * 因此改由测试兜底：扫描全部调用点，断言每个权限标识都真实存在于
 * `@gf/contracts` 的 `PERMISSIONS` 中。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PERMISSION_SET } from '@gf/contracts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** 收集 `permission="x"`、`useCan('x')`、`useCanWrite('x')`、`can('x')` 四种写法。 */
function collectPermissionIdentifiers(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const patterns = [
      /permission=\{?["']([a-zA-Z][\w.]*)["']/g,
      /\buseCan(?:Write|Any)?\(\s*["']([a-zA-Z][\w.]*)["']/g,
      /\bcan\(\s*["']([a-zA-Z][\w.]*)["']/g,
    ];
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const rel = path.relative(SRC, file);
        found.set(m[1], [...(found.get(m[1]) ?? []), rel]);
      }
    }
  }
  return found;
}

describe('界面权限门禁', () => {
  it('界面引用的每个权限标识都存在于服务端契约中', () => {
    const used = collectPermissionIdentifiers();
    const unknown = [...used.entries()]
      .filter(([permission]) => !PERMISSION_SET.has(permission))
      .map(([permission, files]) => `${permission} (${[...new Set(files)].join(', ')})`);
    expect(unknown).toEqual([]);
  });

  it('确实扫描到了权限调用点（防止正则失效后测试变成空跑）', () => {
    // 断言本身若因正则改坏而收集不到任何调用点，上一条会永远通过
    expect(collectPermissionIdentifiers().size).toBeGreaterThan(0);
  });
});
