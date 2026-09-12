/**
 * 图片上传的安全回归。
 *
 * 断言两件此前不成立的事：
 *   ① 上传的是**压缩后的字节**，不是用户选的那个原文件
 *   ② SVG 不接受
 *
 * 原来的实现算出了压缩结果却把原文件传了上去 —— 512px 上限、EXIF 剥离、
 * 载荷清洗全部白做，而代码读起来像是做了。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const uploadSpy = vi.fn();
vi.mock('./supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => {
          uploadSpy(...args);
          return Promise.resolve({ data: { path: 'store_logos/x.webp' }, error: null });
        },
        getPublicUrl: () => ({ data: { publicUrl: 'https://example.invalid/x.webp' } }),
      }),
    },
  },
}));

const { processLocalImage, uploadImageToStorage } = await import('./imageUpload');

beforeEach(() => {
  uploadSpy.mockClear();

  /*
   * jsdom 不解码图片：`new Image()` 的 onload / onerror 都不会触发，
   * canvas 路径会永远挂住。桩掉这两样，让压缩路径真的走完 ——
   * 否则下面那两条断言会因为函数根本没返回而变成空断言。
   */
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 1024;
    height = 768;
    set src(_v: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/webp;base64,UklGRhoAAABXRUJQ');
});

describe('processLocalImage', () => {
  it('拒绝 SVG —— 它是唯一能绕开 canvas 重编码的格式', async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      'logo.svg', { type: 'image/svg+xml' });
    await expect(processLocalImage(svg)).rejects.toThrow('SVG_NOT_SUPPORTED');
  });

  it('拒绝非图片', async () => {
    const html = new File(['<html>'], 'x.html', { type: 'text/html' });
    await expect(processLocalImage(html)).rejects.toThrow();
  });
});

describe('uploadImageToStorage', () => {
  it('传给存储的不是原始 File —— 原文件会把 EXIF 与夹带内容一起送进公开 bucket', async () => {
    /*
     * jsdom 里没有真正的图片解码，canvas 路径走不通，因此这里断言的是
     * **上传参数的形状**：不管压缩成功与否，第二个参数都不该是那个 File 本身。
     */
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'photo.PNG', { type: 'image/png' });
    await uploadImageToStorage(png, 'store_logos').catch(() => {});
    for (const call of uploadSpy.mock.calls) {
      expect(call[1], '上传的仍然是原始 File').not.toBe(png);
    }
  });

  it('存储路径的扩展名取自压缩结果的类型，不取自用户给的文件名', async () => {
    /*
     * 文件名是调用方给的。拿它的后缀拼存储路径，等于让调用方决定这个对象
     * 以什么 Content-Type 被回吐出来 —— `logo.html` 存成 .html，
     * 直接访问那个公开 URL 时浏览器会当网页渲染。
     */
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'logo.html', { type: 'image/png' });
    await uploadImageToStorage(png, 'store_logos').catch(() => {});
    expect(uploadSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of uploadSpy.mock.calls) {
      expect(String(call[0]), '扩展名跟着用户给的文件名走了').not.toMatch(/\.html$/);
      expect(String(call[0])).toMatch(/\.webp$/);
    }
  });
});
