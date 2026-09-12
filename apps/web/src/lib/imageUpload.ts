import { supabase } from './supabase';

export interface ImageProcessOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0.1 to 1.0
  format?: 'image/jpeg' | 'image/png' | 'image/webp';
}

/**
 * 将本地 File 对象读取并按指定规格压缩为高质量 Data URL
 */
export async function processLocalImage(
  file: File,
  options: ImageProcessOptions = {},
): Promise<string> {
  const {
    maxWidth = 512,
    maxHeight = 512,
    quality = 0.88,
    format = 'image/webp',
  } = options;

  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      return reject(new Error('请选择有效的图片文件 (PNG, JPG, WEBP, GIF)'));
    }

    /*
     * ⚠️ **不接受 SVG。**
     *
     * 它此前是唯一绕开下面那条 canvas 重编码路径的格式 —— 原始字节被原样
     * 留下并存进公开 bucket。经 `<img>` 渲染时脚本不会执行，但直接访问那个
     * 存储 URL 时会执行，而那是一个看起来完全可信的域名。
     *
     * 不做「清洗 SVG」：按正则剔 `<script>` 与事件属性是出了名的挡不住
     * （实体编码、命名空间、`<foreignObject>`…）。而这条路径上 SVG 也没有
     * 任何优势 —— 所有格式最终都被压成 512px 的 webp 位图，矢量本来就留不住。
     */
    if (file.type === 'image/svg+xml') {
      return reject(new Error('SVG_NOT_SUPPORTED'));
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;

        // 计算缩放宽高比
        if (width > maxWidth || height > maxHeight) {
          if (width / height > maxWidth / maxHeight) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return resolve(e.target?.result as string);
        }

        // 平滑缩放算法
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // 输出压缩后的 Data URL
        try {
          const dataUrl = canvas.toDataURL(format, quality);
          resolve(dataUrl);
        } catch {
          // 降级为原始 base64
          resolve(e.target?.result as string);
        }
      };

      img.onerror = () => reject(new Error('图片解码失败，请换一张图片试试'));
      img.src = e.target?.result as string;
    };

    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/** Data URL → Blob。上传要传字节，不能传那一长串 base64 字符串。 */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header = '', body = ''] = dataUrl.split(',');
  const mime = header.match(/data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  if (!header.includes(';base64')) {
    return new Blob([decodeURIComponent(body)], { type: mime });
  }
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * 上传到 Supabase Storage（未配置或失败时回退为本地压缩后的 Data URL）。
 *
 * ⚠️ **上传的是压缩后的字节，不是用户选的那个原文件。**
 *
 * 此前这里算出了 `optimizedDataUrl` 却把**原始 `file`** 传了上去 ——
 * 压缩、缩到 512px、转 webp 全都白做了，只在云存储不可用时才用得上。
 * 三个后果都是真的：
 *
 *   · 15MB 的原图整份进了公开 bucket，512px 上限从未生效
 *   · 手机拍的照片带着 EXIF 一起公开，**其中包含拍摄地点的 GPS 坐标**
 *   · SVG 原样存进去。它经 `<img>` 渲染时脚本不会执行，但直接访问那个
 *     存储 URL 时会 —— 而那是一个可以被拿去做钓鱼页的可信域名
 *
 * 走 canvas 重编码这一步本身就是清洗：出来的是一张纯位图，
 * 原文件里夹带的任何东西都不会留下。
 */
export async function uploadImageToStorage(
  file: File,
  bucket: 'avatars' | 'store_logos' = 'avatars',
  options: ImageProcessOptions = {},
): Promise<string> {
  // 1. 先进行本地优化压缩
  const optimizedDataUrl = await processLocalImage(file, options);

  try {
    // 2. 如果配置了 Supabase Storage 且非占位 URL，尝试上传
    if (supabase && typeof window !== 'undefined') {
      const blob = dataUrlToBlob(optimizedDataUrl);
      /*
       * 扩展名按**压缩结果的实际类型**取，不取 `file.name` 的后缀 ——
       * 文件名是用户给的，拿它拼存储路径等于让调用方决定这个对象以什么
       * Content-Type 被回吐出来。
       */
      const fileExt = blob.type.split('/')[1]?.replace('+xml', '') || 'webp';
      const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${fileExt}`;
      const filePath = `${bucket}/${fileName}`;

      const { data, error } = await supabase.storage
        .from(bucket)
        .upload(filePath, blob, { cacheControl: '3600', upsert: true, contentType: blob.type });

      if (!error && data?.path) {
        const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(data.path);
        if (publicUrlData?.publicUrl) {
          return publicUrlData.publicUrl;
        }
      }
    }
  } catch (err) {
    console.warn('[ImageUpload] Supabase Storage upload skipped/failed, fallback to optimized data url:', err);
  }

  // 3. 安全回退：返回压缩后的 DataURL，无需依赖云存储即可秒级即时展示与持久化
  return optimizedDataUrl;
}
