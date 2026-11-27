// 老拓片照片与数字拓片的自动配准与差异检测
// 配准模型：平移+旋转+缩放（4 参数相似变换 -> 3x3 单应），对老拓片照片足够稳健

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

/** 降采样到目标长边，返回新图与相对原图的尺度 */
export function downscaleGray(img: GrayImage, maxSide: number): { img: GrayImage; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) return { img, scale: 1 };
  const nw = Math.max(2, Math.round(img.width * scale));
  const nh = Math.max(2, Math.round(img.height * scale));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const sy = (y + 0.5) / scale - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const x1 = Math.min(img.width - 1, x0 + 1);
      const y1 = Math.min(img.height - 1, y0 + 1);
      const a = img.data[y0 * img.width + x0];
      const b = img.data[y0 * img.width + x1];
      const c = img.data[y1 * img.width + x0];
      const d = img.data[y1 * img.width + x1];
      out[y * nw + x] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return { img: { data: out, width: nw, height: nh }, scale };
}

/** 由相似变换参数构造 3x3 单应（dst 像素 -> src 像素，列主序） */
export function similarityHomography(tx: number, ty: number, angle: number, s: number): number[] {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  // src = R*s * dst + t
  return [c * s, sn * s, 0, -sn * s, c * s, 0, tx, ty, 1];
}

function nccAt(
  ref: GrayImage,
  tpl: GrayImage,
  H: number[],
  sampleStep: number,
): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
  for (let y = 0; y < tpl.height; y += sampleStep) {
    for (let x = 0; x < tpl.width; x += sampleStep) {
      const w = h2 * x + h5 * y + h8 || 1;
      const sx = (h0 * x + h3 * y + h6) / w;
      const sy = (h1 * x + h4 * y + h7) / w;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 1 || y0 < 1 || x0 >= ref.width - 1 || y0 >= ref.height - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const a =
        ref.data[y0 * ref.width + x0] * (1 - fx) * (1 - fy) +
        ref.data[y0 * ref.width + x0 + 1] * fx * (1 - fy) +
        ref.data[(y0 + 1) * ref.width + x0] * (1 - fx) * fy +
        ref.data[(y0 + 1) * ref.width + x0 + 1] * fx * fy;
      const b = tpl.data[y * tpl.width + x];
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
      n++;
    }
  }
  if (n < 50) return -1;
  const ma = sa / n;
  const mb = sb / n;
  const va = saa / n - ma * ma;
  const vb = sbb / n - mb * mb;
  if (va <= 0 || vb <= 0) return -1;
  return (sab / n - ma * mb) / Math.sqrt(va * vb);
}

export interface RegistrationResult {
  /** dst(老照片)->ref(数字拓片) 的 3x3 单应，列主序 */
  H: number[];
  ncc: number;
}

/**
 * 自动配准：在低分辨率上做平移网格粗搜 + 角度/尺度细搜，再坐标下降精修。
 * @param ref 数字拓片灰度图（参考）
 * @param photo 老拓片照片灰度图（待配准）
 */
export function registerImages(ref: GrayImage, photo: GrayImage, onProgress?: (p: number) => void): RegistrationResult {
  const workMax = 320;
  const r = downscaleGray(ref, workMax);
  const p = downscaleGray(photo, workMax);
  const refW = r.img.width;
  const refH = r.img.height;
  const phoW = p.img.width;
  const phoH = p.img.height;

  // 初始尺度：让老照片长边与参考图长边对齐
  const s0 = Math.max(refW, refH) / Math.max(phoW, phoH);
  let best = { tx: (refW - phoW * s0) / 2, ty: (refH - phoH * s0) / 2, angle: 0, s: s0, ncc: -2 };

  const evalParams = (tx: number, ty: number, angle: number, s: number): number => {
    // H: dst(photo 低分辨率) -> ref(低分辨率)
    const H = similarityHomography(tx, ty, angle, s);
    return nccAt(r.img, p.img, H, 2);
  };

  // 1. 平移粗搜
  const rangeX = refW * 0.25;
  const rangeY = refH * 0.25;
  const steps = 9;
  let iter = 0;
  const totalIters = steps * steps + 24;
  for (let iy = 0; iy < steps; iy++) {
    for (let ix = 0; ix < steps; ix++) {
      const tx = best.tx + (ix / (steps - 1) - 0.5) * 2 * rangeX;
      const ty = best.ty + (iy / (steps - 1) - 0.5) * 2 * rangeY;
      const ncc = evalParams(tx, ty, best.angle, best.s);
      if (ncc > best.ncc) best = { ...best, tx, ty, ncc };
      iter++;
      onProgress?.(iter / totalIters);
    }
  }

  // 2. 坐标下降精修（平移、角度、尺度，逐步缩小步长）
  const deltas = [
    { tx: 4, ty: 0, angle: 0, s: 0 },
    { tx: -4, ty: 0, angle: 0, s: 0 },
    { tx: 0, ty: 4, angle: 0, s: 0 },
    { tx: 0, ty: -4, angle: 0, s: 0 },
    { tx: 0, ty: 0, angle: 0.04, s: 0 },
    { tx: 0, ty: 0, angle: -0.04, s: 0 },
    { tx: 0, ty: 0, angle: 0, s: 0.03 },
    { tx: 0, ty: 0, angle: 0, s: -0.03 },
  ];
  for (let round = 0; round < 3; round++) {
    const shrink = 1 / (round + 1);
    let improved = true;
    while (improved) {
      improved = false;
      for (const d of deltas) {
        const tx = best.tx + d.tx * shrink;
        const ty = best.ty + d.ty * shrink;
        const angle = best.angle + d.angle * shrink;
        const s = best.s * (1 + d.s * shrink);
        const ncc = evalParams(tx, ty, angle, s);
        iter++;
        onProgress?.(Math.min(1, iter / totalIters));
        if (ncc > best.ncc) {
          best = { tx, ty, angle, s, ncc };
          improved = true;
        }
      }
    }
  }

  // 3. 换算回原始分辨率：低分辨率 H 的平移除以各自降采样比
  // ref 降采样比 rs，photo 降采样比 ps；原 H = diag(1/rs) * H_low * diag(ps)
  const rs = r.scale;
  const ps = p.scale;
  const Hlow = similarityHomography(best.tx, best.ty, best.angle, best.s);
  const scaleConv = ps / rs;
  const H: number[] = [
    Hlow[0] * scaleConv,
    Hlow[1] * scaleConv,
    0,
    Hlow[3] * scaleConv,
    Hlow[4] * scaleConv,
    0,
    Hlow[6] / rs,
    Hlow[7] / rs,
    1,
  ];
  return { H, ncc: best.ncc };
}

/**
 * 差异检测：配准后逐像素比较，返回差异概率掩膜（0..1）。
 * 局部归一化可抵抗老照片曝光不均；仅在“数字拓片为白（无墨）而老照片有墨”
 * 与“数字拓片有墨而老照片变白（泐损）”两类区域响应。
 */
export function computeDiffMask(
  ref: GrayImage,
  photo: GrayImage,
  H: number[],
  radius = 6,
  threshold = 22,
): Float32Array {
  const mask = new Float32Array(ref.width * ref.height);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
  // 先把老照片 warp 到参考图网格
  const warped = new Float32Array(ref.width * ref.height).fill(255);
  for (let y = 0; y < ref.height; y++) {
    for (let x = 0; x < ref.width; x++) {
      const w = h2 * x + h5 * y + h8 || 1;
      const sx = (h0 * x + h3 * y + h6) / w;
      const sy = (h1 * x + h4 * y + h7) / w;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 1 || y0 < 1 || x0 >= photo.width - 1 || y0 >= photo.height - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      warped[y * ref.width + x] =
        photo.data[y0 * photo.width + x0] * (1 - fx) * (1 - fy) +
        photo.data[y0 * photo.width + x0 + 1] * fx * (1 - fy) +
        photo.data[(y0 + 1) * photo.width + x0] * (1 - fx) * fy +
        photo.data[(y0 + 1) * photo.width + x0 + 1] * fx * fy;
    }
  }
  // 盒式均值近似局部归一化
  const mean = boxBlur(warped, ref.width, ref.height, radius);
  const refMean = boxBlur(ref.data, ref.width, ref.height, radius);
  for (let i = 0; i < mask.length; i++) {
    const d = warped[i] - mean[i] - (ref.data[i] - refMean[i]);
    // 老照片有墨（暗）而数字拓片无墨 -> 后期泐损；反向差异同样保留
    const v = Math.max(0, Math.abs(d) - threshold) / 60;
    mask[i] = Math.min(1, v);
  }
  // 形态学膨胀让差异区域连成可读的斑块
  return dilate(mask, ref.width, ref.height, 2);
}

function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * W + Math.max(0, Math.min(W - 1, x))];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = sum / (2 * r + 1);
      const xr = Math.min(W - 1, x + r + 1);
      const xl = Math.max(0, x - r);
      sum += src[y * W + xr] - src[y * W + xl];
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.max(0, Math.min(H - 1, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = sum / (2 * r + 1);
      const yr = Math.min(H - 1, y + r + 1);
      const yl = Math.max(0, y - r);
      sum += tmp[yr * W + x] - tmp[yl * W + x];
    }
  }
  return out;
}

function dilate(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const v = src[yy * W + xx];
          if (v > m) m = v;
        }
      }
      out[y * W + x] = m;
    }
  }
  return out;
}
