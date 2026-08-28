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
    // 检查文件类型
    if (!file.type.startsWith('image/')) {
      return reject(new Error('请选择有效的图片文件 (PNG, JPG, WEBP, GIF, SVG)'));
    }

    // SVG 直接读取为 DataURL
    if (file.type === 'image/svg+xml') {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('读取 SVG 图片失败'));
      reader.readAsDataURL(file);
      return;
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

/**
 * 尝试上传到 Supabase Storage（若未配置或失败则自动回退至本地处理的高清 Base64 Data URL）
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
      const fileExt = file.name.split('.').pop() || 'webp';
      const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${fileExt}`;
      const filePath = `${bucket}/${fileName}`;

      const { data, error } = await supabase.storage
        .from(bucket)
        .upload(filePath, file, { cacheControl: '3600', upsert: true });

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
