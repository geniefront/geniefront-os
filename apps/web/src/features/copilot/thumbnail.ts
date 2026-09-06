/**
 * 截图缩略图。
 *
 * ## 为什么历史里存的是缩略图，不是原图
 *
 * 前台发来的预约截图动辄 100KB~2MB 的 base64。localStorage 一共只有 5MB，
 * 存几张原图就把整个会话历史挤爆 —— 而配额一满，**后续所有写入静默失败**，
 * 表现是「聊天记录莫名其妙不再保存了」，没有任何报错。
 *
 * 所以此前的做法是干脆把 `imagePreview` 整个剥掉不存。代价是重开抽屉后
 * 历史里只剩一句「导入这些预约」，前台看不出自己当时发的是哪张图，
 * 也就没法判断这段对话说的是哪一批单。
 *
 * 折中：**存一张压到 320px 宽的 JPEG 缩略图**（通常 5~15KB）。
 * 看得清是哪张表，又不至于撑爆配额。原图只在当次请求里用完即弃 ——
 * 模型那一侧要的是清晰度，浏览器这一侧要的只是「认得出来」。
 */

/** 缩略图最长边。够认出「哦是那张预约表」，不用够读清每个字 */
const MAX_EDGE = 320;
/** JPEG 质量。0.6 在这个尺寸上肉眼已经看不出区别 */
const QUALITY = 0.6;

/**
 * 把 data URL 压成小缩略图。
 *
 * 任何一步出问题都返回 `null` 而不是抛错 —— 缩略图是锦上添花，
 * 它失败了不该影响这条消息本身的发送。
 */
export async function makeThumbnail(dataUrl: string): Promise<string | null> {
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // 截图多半是白底表格，先铺白底再画 —— 否则带透明通道的 PNG
    // 转成 JPEG 之后透明区会变黑，整张图看起来像坏了
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    return canvas.toDataURL('image/jpeg', QUALITY);
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}
