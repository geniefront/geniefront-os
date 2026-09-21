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
          return reject(new Error('IMAGE_PROCESSING_FAILED'));
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
          // Do not upload unprocessed bytes if re-encoding fails.
          reject(new Error('IMAGE_PROCESSING_FAILED'));
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

/** Upload only re-encoded pixels. Failed uploads never become persisted data URLs. */
export async function uploadImageToStorage(
  file: File,
  bucket: 'avatars' | 'store_logos' = 'avatars',
  options: ImageProcessOptions = {},
): Promise<string> {
  const optimizedDataUrl = await processLocalImage(file, options);
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) throw new Error('IMAGE_UPLOAD_FAILED');
  const blob = dataUrlToBlob(optimizedDataUrl);
  const fileExt = blob.type.split('/')[1];
  const filePath = `${auth.user.id}/${crypto.randomUUID()}.${fileExt}`;
  const { data, error } = await supabase.storage.from(bucket).upload(filePath, blob, {
    cacheControl: '3600', upsert: false, contentType: blob.type,
  });
  if (error || !data?.path) throw new Error('IMAGE_UPLOAD_FAILED');
  const { data: result } = supabase.storage.from(bucket).getPublicUrl(data.path);
  const url = result?.publicUrl;
  if (!url || !url.startsWith('https://') || url.length > 2048) throw new Error('IMAGE_UPLOAD_FAILED');
  return url;
}
