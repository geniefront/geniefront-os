// @vitest-environment node
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDir = resolve(process.cwd(), 'public');

describe('technician PWA shell', () => {
  it('ships every icon referenced by the manifest', async () => {
    const manifest = JSON.parse(await readFile(resolve(publicDir, 'manifest.webmanifest'), 'utf8')) as {
      start_url: string;
      icons: Array<{ src: string }>;
    };
    /*
     * 起始地址必须是 `/`，由路由按登录角色与屏幕尺寸决定落到技师端还是前台端。
     * 写死 `/tech/today` 时，门店 iPad 把前台工作台添加到主屏幕后，每次冷启动
     * 都先落进技师今日页。
     */
    expect(manifest.start_url).toBe('/');
    // 横竖屏都要能用：前台 iPad 常年横屏，锁定 portrait 会把它挡在门外。
    expect(manifest).not.toHaveProperty('orientation');
    await Promise.all(manifest.icons.map((icon) => access(resolve(publicDir, icon.src.replace(/^\//, '')))));
  });

  it('keeps API traffic and non-GET writes outside Cache Storage', async () => {
    const worker = await readFile(resolve(publicDir, 'sw.js'), 'utf8');
    expect(worker).toContain("request.method !== 'GET'");
    expect(worker).toContain("url.pathname.startsWith('/v1/')");
    expect(worker).toContain("url.pathname.startsWith('/api/')");
    expect(worker).not.toContain('sync.addEventListener');
  });
});
