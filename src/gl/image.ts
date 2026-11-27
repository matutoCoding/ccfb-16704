// 图像工具：灰度化、缩放、TIFF 编码、单字裁切

export function toGrayscale(img: ImageData): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
  }
  return out;
}

/** 双线性缩放灰度图（带可选单应变换，用于配准） */
export function warpGray(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  H: number[] | null, // 列主序 3x3，dst -> src
): Float32Array {
  const dst = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let sx = (x + 0.5) * (srcW / dstW);
      let sy = (y + 0.5) * (srcH / dstH);
      if (H) {
        const wx = H[0] * x + H[3] * y + H[6];
        const wy = H[1] * x + H[4] * y + H[7];
        const w = H[2] * x + H[5] * y + H[8] || 1;
        sx = wx / w;
        sy = wy / w;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= srcW - 1 || y0 >= srcH - 1) {
        dst[y * dstW + x] = 255;
        continue;
      }
      const fx = sx - x0;
      const fy = sy - y0;
      const a = src[y0 * srcW + x0];
      const b = src[y0 * srcW + x0 + 1];
      const c = src[(y0 + 1) * srcW + x0];
      const d = src[(y0 + 1) * srcW + x0 + 1];
      dst[y * dstW + x] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return dst;
}

/**
 * 无压缩 TIFF（LZW 对出版软件兼容性参差，先出基线 TIFF，灰度 8bit）
 * 小端字节序，单 IFD，条带按行组织。
 */
export function encodeTiffGray(img: ImageData, dpi: number): Blob {
  const W = img.width;
  const H = img.height;
  const gray = toGrayscale(img);
  const rowsPerStrip = Math.min(H, 256);
  const stripCount = Math.ceil(H / rowsPerStrip);
  const stripBytes = rowsPerStrip * W;
  const headerSize = 8;
  const ifdCount = 11;
  const ifdSize = 2 + ifdCount * 12 + 4;
  const dataOff = headerSize + ifdSize;
  const stripTableOff = dataOff + gray.length;

  const buf = new ArrayBuffer(stripTableOff + stripCount * 4);
  const dv = new DataView(buf);
  // Header: II 42 offset 8
  dv.setUint16(0, 0x4949, true);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  // IFD
  dv.setUint16(8, ifdCount, true);
  const tags: [number, number, number, number][] = [
    [256, 3, 1, W], // ImageWidth SHORT
    [257, 3, 1, H], // ImageLength
    [258, 3, 1, 8], // BitsPerSample
    [259, 3, 1, 1], // Compression = none
    [262, 3, 1, 1], // Photometric = BlackIsZero
    [273, 4, stripCount, stripTableOff], // StripOffsets
    [277, 3, 1, 1], // SamplesPerPixel
    [278, 3, 1, rowsPerStrip], // RowsPerStrip
    [279, 4, stripCount, stripTableOff + stripCount * 4], // StripByteCounts（表后；此处简化为等长，末条带可能不足）
    [282, 5, 1, 0], // XResolution 偏移占位，下面写 RATIONAL
    [283, 5, 1, 0], // YResolution
  ];
  // 分辨率 RATIONAL 放在 strip table 之后
  const rationalOff = stripTableOff + stripCount * 4 + stripCount * 4;
  tags[9][3] = rationalOff;
  tags[10][3] = rationalOff + 8;
  let p = 10;
  for (const [tag, type, count, value] of tags) {
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(p + 8, value, true);
    else dv.setUint32(p + 8, value, true);
    p += 12;
  }
  dv.setUint32(p, 0, true); // next IFD

  // 像素数据
  const bytes = new Uint8Array(buf);
  bytes.set(gray instanceof Float32Array ? Uint8Array.from(gray, (v) => Math.max(0, Math.min(255, Math.round(v)))) : gray, dataOff);

  // strip offset / bytecount 表
  for (let i = 0; i < stripCount; i++) {
    dv.setUint32(stripTableOff + i * 4, dataOff + i * stripBytes, true);
    const rows = Math.min(rowsPerStrip, H - i * rowsPerStrip);
    dv.setUint32(stripTableOff + stripCount * 4 + i * 4, rows * W, true);
  }
  // RATIONAL dpi/1
  dv.setUint32(rationalOff, dpi, true);
  dv.setUint32(rationalOff + 4, 1, true);
  dv.setUint32(rationalOff + 8, dpi, true);
  dv.setUint32(rationalOff + 12, 1, true);

  return new Blob([buf], { type: 'image/tiff' });
}

/** PNG 编码（离屏 canvas，浏览器原生） */
export async function encodePng(img: ImageData): Promise<Blob> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

/** 按 mm 坐标框裁切 ImageData */
export function cropImage(img: ImageData, fullWmm: number, fullHmm: number, bbox: { x: number; y: number; w: number; h: number }): ImageData {
  const sx = (bbox.x / fullWmm) * img.width;
  const sy = (bbox.y / fullHmm) * img.height;
  const sw = (bbox.w / fullWmm) * img.width;
  const sh = (bbox.h / fullHmm) * img.height;
  const x0 = Math.max(0, Math.round(sx));
  const y0 = Math.max(0, Math.round(sy));
  const x1 = Math.min(img.width, Math.round(sx + sw));
  const y1 = Math.min(img.height, Math.round(sy + sh));
  const out = new ImageData(x1 - x0, y1 - y0);
  for (let y = 0; y < y1 - y0; y++) {
    const srcStart = ((y0 + y) * img.width + x0) * 4;
    out.data.set(img.data.subarray(srcStart, srcStart + (x1 - x0) * 4), y * (x1 - x0) * 4);
  }
  return out;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
