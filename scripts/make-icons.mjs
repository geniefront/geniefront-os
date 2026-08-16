/**
 * 生成 PWA 图标（192 / 512 PNG）。
 *
 * 为什么手写一个 PNG 编码器而不是装 sharp：这两张图一年改不了一次，
 * 为它们背一个带原生二进制的依赖不划算 —— 而且 CI 里装 sharp
 * 是构建变慢与偶发失败的常见来源。
 *
 * 用法：node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'staff', 'public');

const BRAND = [0xb8, 0x14, 0x3c];   // --brand
const INK = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 画一个圆角方块底 + 中间一个白色「铃铛」形状的近似（圆 + 缺口）。
 * 图标要在手机主屏上一眼认出来，所以形状比细节重要。
 */
function pixel(x, y, size) {
  const r = size * 0.22;                       // 圆角半径
  const inset = size * 0.02;
  const cx = size / 2;
  const cy = size / 2;

  // 圆角矩形外面 = 透明
  const nx = Math.min(Math.max(x, inset + r), size - inset - r);
  const ny = Math.min(Math.max(y, inset + r), size - inset - r);
  if ((x - nx) ** 2 + (y - ny) ** 2 > r * r) return [0, 0, 0, 0];

  // 中间的白色圆（铃身）
  const bell = size * 0.20;
  const dy = y - cy + size * 0.02;
  if ((x - cx) ** 2 + dy ** 2 <= bell * bell) return [...INK, 255];
  // 铃锤：底部小圆
  const kx = cx;
  const ky = cy + size * 0.26;
  const kr = size * 0.07;
  if ((x - kx) ** 2 + (y - ky) ** 2 <= kr * kr) return [...INK, 255];

  return [...BRAND, 255];
}

function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                              // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, makePng(size));
  console.log(`✓ ${file}`);
}
