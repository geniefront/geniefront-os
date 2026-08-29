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
    expect(manifest.start_url).toBe('/tech/today');
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
