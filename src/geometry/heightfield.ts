import type { HeightField } from '../types';
import { clamp } from './math';

export interface RasterOptions {
  /** 目标分辨率 px/mm，默认 5（0.2mm 采样间隔） */
  pxPerMm?: number;
  /** 二次曲面去趋势，去除碑面整体弯曲，默认 true */
  detrend?: boolean;
  /** 空洞最大迭代填补次数，默认 8 */
  fillIters?: number;
  onProgress?: (pct: number) => void;
}

/**
 * 将基准面局部坐标 (u,v,w) 的三角网格光栅化为规则高度场。
 * 每像素取覆盖它的三角形中最大 w（最靠近扫描器的表面），
 * 保证阴刻刻口边缘落在真实三角形边界上。
 */
export function rasterizeHeightField(
  local: Float32Array,
  indices: Uint32Array,
  opts: RasterOptions = {},
): HeightField {
  const pxPerMm = opts.pxPerMm ?? 5;
  const detrend = opts.detrend ?? true;
  const fillIters = opts.fillIters ?? 3;

  // 1. 包围盒（v 轴翻转：图像坐标 y 向下）
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < local.length; i += 3) {
    const u = local[i];
    const v = local[i + 1];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const margin = 1;
  const widthMm = maxU - minU + margin * 2;
  const heightMm = maxV - minV + margin * 2;
  const W = Math.max(2, Math.round(widthMm * pxPerMm));
  const H = Math.max(2, Math.round(heightMm * pxPerMm));
  const data = new Float32Array(W * H).fill(NaN);

  const toPxX = (u: number): number => (u - minU + margin) * pxPerMm;
  const toPxY = (v: number): number => (maxV - v + margin) * pxPerMm;

  // 2. 规则网格快速路径：目标像素逆映射到源网格双线性插值，无空洞 O(W*H)
  const grid = detectRegularGrid(local, indices);
  if (grid) {
    rasterizeGridInverse(local, grid, data, W, H, minU, minV, maxV, margin, pxPerMm, opts.onProgress);
  } else {
    rasterizeTriangles(local, indices, data, W, H,
      (u) => (u - minU + margin) * pxPerMm,
      (v) => (maxV - v + margin) * pxPerMm,
      opts.onProgress);
  }

  // 3. 二次曲面去趋势（整体弯曲/倾斜），稳健拟合返回石面基准常数
  const baseline = detrend ? detrendQuadratic(data, W, H) : 0;

  // 4. 空洞填补：迭代取有效邻居均值
  fillHoles(data, W, H, fillIters);

  // 5. 以石面基准归零（凸起为正、阴刻为负）
  for (let i = 0; i < data.length; i++) data[i] -= baseline;

  opts.onProgress?.(1);
  return { data, widthPx: W, heightPx: H, pxPerMm, widthMm, heightMm };
}

interface GridInfo {
  nx: number;
  ny: number;
}

/** 检测索引是否为规则四边形网格（三角形连接模式 a,c,b / b,c,d 且顶点数=nx*ny） */
export function detectRegularGrid(local: Float32Array, indices: Uint32Array): GridInfo | null {
  const vcount = local.length / 3;
  if (indices.length < 6) return null;
  // 标准模式（见生成器）：单元三角为 (a, a+nx, a+1) 与 (a+1, a+nx, a+nx+1)
  const a = indices[0];
  const b = indices[2]; // a+1
  const c = indices[1]; // a+nx
  if (b !== a + 1 || c <= a) return null;
  const nx = c - a;
  if (nx < 2 || vcount % nx !== 0) return null;
  const ny = vcount / nx;
  if (!Number.isInteger(ny) || ny < 2) return null;
  // 校验若干抽样单元
  for (const triBase of [0, Math.floor(indices.length / 12), Math.floor(indices.length / 2) - 3]) {
    const i = triBase * 6;
    if (i + 5 >= indices.length) continue;
    const aa = indices[i];
    if (indices[i + 2] !== aa + 1 || indices[i + 1] !== aa + nx) return null;
  }
  return { nx, ny };
}

/**
 * 规则网格逆映射光栅化：
 * 目标像素 (px,py) -> 物理 (u,v) -> 源网格行列号 (fi,fj)。
 * 采用最近邻取值（而非双线性）：阴刻刻口是高频不连续面，插值会把槽壁斜率摊平、
 * 吃掉真实槽深并使刻口变糊；最近邻完整保留源网格的深度与锐利边界，
 * 当目标分辨率≥源网格时每个源点都被覆盖，无空洞。
 */
function rasterizeGridInverse(
  local: Float32Array,
  grid: GridInfo,
  data: Float32Array,
  W: number,
  H: number,
  minU: number,
  minV: number,
  maxV: number,
  margin: number,
  pxPerMm: number,
  onProgress?: (p: number) => void,
): void {
  const { nx, ny } = grid;
  const spanU = local[(nx - 1) * 3] - local[0];
  const spanV = local[(ny - 1) * nx * 3 + 1] - local[1];
  const invDu = (nx - 1) / spanU;
  const invDv = (ny - 1) / spanV;
  const u0 = local[0];
  const v0 = local[1];
  const invRes = 1 / pxPerMm;

  for (let py = 0; py < H; py++) {
    const v = maxV - ((py + 0.5) * invRes - margin);
    let fj = (v - v0) * invDv;
    if (fj < 0) fj = 0;
    else if (fj > ny - 1) fj = ny - 1;
    const j = Math.round(fj);
    const rowBase = j * nx;
    let outIdx = py * W;
    for (let px = 0; px < W; px++) {
      const u = minU + ((px + 0.5) * invRes - margin);
      let fi = (u - u0) * invDu;
      if (fi < 0) fi = 0;
      else if (fi > nx - 1) fi = nx - 1;
      const i = Math.round(fi);
      data[outIdx++] = local[(rowBase + i) * 3 + 2];
    }
    if (onProgress && (py & 63) === 0) onProgress(py / H);
  }
}

/** 通用三角形边缘函数光栅化（非规则网格回退路径） */
function rasterizeTriangles(
  local: Float32Array,
  indices: Uint32Array,
  data: Float32Array,
  W: number,
  H: number,
  toPxX: (u: number) => number,
  toPxY: (v: number) => number,
  onProgress?: (p: number) => void,
): void {
  const triCount = indices.length / 3;
  const reportEvery = Math.max(1, Math.floor(triCount / 50));
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const ax = toPxX(local[ia]);
    const ay = toPxY(local[ia + 1]);
    const bx = toPxX(local[ib]);
    const by = toPxY(local[ib + 1]);
    const cx = toPxX(local[ic]);
    const cy = toPxY(local[ic + 1]);
    const wa = local[ia + 2];
    const wb = local[ib + 2];
    const wc = local[ic + 2];

    const minX = clamp(Math.floor(Math.min(ax, bx, cx)), 0, W - 1);
    const maxX = clamp(Math.ceil(Math.max(ax, bx, cx)), 0, W - 1);
    const minY = clamp(Math.floor(Math.min(ay, by, cy)), 0, H - 1);
    const maxY = clamp(Math.ceil(Math.max(ay, by, cy)), 0, H - 1);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const invArea = 1 / area;

    for (let py = minY; py <= maxY; py++) {
      for (let pxx = minX; pxx <= maxX; pxx++) {
        const sx = pxx + 0.5;
        const sy = py + 0.5;
        const l0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) * invArea;
        const l1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) * invArea;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const w = l0 * wa + l1 * wb + l2 * wc;
        const o = py * W + pxx;
        if (Number.isNaN(data[o]) || w > data[o]) data[o] = w;
      }
    }
    if (onProgress && t % reportEvery === 0) onProgress(t / triCount);
  }
}

/**
 * 稳健二次去趋势（迭代加权最小二乘 IRLS）：
 * 刻槽/风化坑是离群低点。固定窄容差在大弯曲面上会把弯曲边缘误判成刻槽而排除，
 * 使拟合只用局部条带、曲面失准。改为：
 *  1) 直方图众数峰定位石面高度；
 *  2) 取峰以上（高于石面的凸起/石面本身，绝不含向低值长尾的刻槽）的点做初拟合；
 *  3) 按残差迭代，仅保留残差在小正区间内的点重拟合，收敛到石面弯曲面。
 * 返回图像中心处的石面基准高度。
 */
function detrendQuadratic(data: Float32Array, W: number, H: number): number {
  const peak = modalPeakValue(data);

  const sx = W / 2;
  const sy = H / 2;
  const feats = new Float32Array(6);
  let inlier = new Uint8Array(data.length);
  // 初始内点：z >= 峰 - 0.5（刻槽向更低值长尾，石面与凸起在峰附近及以上）
  let n0 = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === v && v >= peak - 0.5) { inlier[i] = 1; n0++; }
  }
  if (n0 < 100) return 0;

  let coef: number[] | null = null;
  for (let iter = 0; iter < 4; iter++) {
    const A = new Float64Array(42);
    let n = 0;
    for (let py = 0; py < H; py++) {
      const y = (py - sy) / H;
      const rowBase = py * W;
      for (let px = 0; px < W; px++) {
        const o = rowBase + px;
        if (!inlier[o]) continue;
        const w = data[o];
        const x = (px - sx) / W;
        feats[0] = 1; feats[1] = x; feats[2] = y; feats[3] = x * x; feats[4] = x * y; feats[5] = y * y;
        for (let i = 0; i < 6; i++) {
          A[i * 7 + 6] += feats[i] * w;
          for (let j = 0; j < 6; j++) A[i * 7 + j] += feats[i] * feats[j];
        }
        n++;
      }
    }
    if (n < 100) break;
    coef = solve6(A);
    // 重新选内点：残差落在 [-0.3, +0.3]（石面贴合曲面），刻槽残差为大负值被剔除
    const next = new Uint8Array(data.length);
    let cnt = 0;
    for (let py = 0; py < H; py++) {
      const y = (py - sy) / H;
      const rowBase = py * W;
      for (let px = 0; px < W; px++) {
        const o = rowBase + px;
        const v = data[o];
        if (v !== v) continue;
        const x = (px - sx) / W;
        const trend = coef[0] + coef[1] * x + coef[2] * y + coef[3] * x * x + coef[4] * x * y + coef[5] * y * y;
        const r = v - trend;
        if (r > -0.3 && r < 0.4) { next[o] = 1; cnt++; }
      }
    }
    inlier = next;
    if (cnt < 100) break;
  }
  if (!coef) return 0;
  const [c0, c1, c2, c3, c4, c5] = coef;
  // 只扣非常数项，保留石面绝对高度，常数基准由调用方统一归零
  for (let py = 0; py < H; py++) {
    const y = (py - sy) / H;
    const rowBase = py * W;
    for (let px = 0; px < W; px++) {
      const o = rowBase + px;
      if (data[o] !== data[o]) continue;
      const x = (px - sx) / W;
      data[o] -= c1 * x + c2 * y + c3 * x * x + c4 * x * y + c5 * y * y;
    }
  }
  return c0;
}

function solve6(A: Float64Array): number[] {
  for (let col = 0; col < 6; col++) {
    let piv = col;
    for (let r = col + 1; r < 6; r++) if (Math.abs(A[r * 7 + col]) > Math.abs(A[piv * 7 + col])) piv = r;
    for (let k = 0; k < 7; k++) {
      const tmp = A[col * 7 + k];
      A[col * 7 + k] = A[piv * 7 + k];
      A[piv * 7 + k] = tmp;
    }
    const d = A[col * 7 + col] || 1e-30;
    for (let k = 0; k < 7; k++) A[col * 7 + k] /= d;
    for (let r = 0; r < 6; r++) {
      if (r === col) continue;
      const f = A[r * 7 + col];
      if (f === 0) continue;
      for (let k = 0; k < 7; k++) A[r * 7 + k] -= f * A[col * 7 + k];
    }
  }
  return [A[6], A[13], A[20], A[27], A[34], A[41]];
}

/** 直方图众数峰值（石面所在高度） */
function modalPeakValue(data: Float32Array): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const BINS = 4096;
  const hist = new Uint32Array(BINS);
  const scale = BINS / (hi - lo || 1);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) continue;
    let b = ((v - lo) * scale) | 0;
    if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }
  let peakBin = 0;
  let peakCount = 0;
  for (let b = 0; b < BINS; b++) if (hist[b] > peakCount) { peakCount = hist[b]; peakBin = b; }
  return lo + (peakBin + 0.5) / scale;
}

/** 两遍扫描的直方图中位数：先找 min/max，再 4096 桶定位中位区间，线性插值 */
function histogramMedian(data: Float32Array): number {
  let lo = Infinity;
  let hi = -Infinity;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    count++;
  }
  if (!count) return 0;
  if (hi - lo < 1e-9) return lo;
  const BINS = 4096;
  const hist = new Uint32Array(BINS);
  const scale = BINS / (hi - lo);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) continue;
    let b = ((v - lo) * scale) | 0;
    if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }
  const half = count >> 1;
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    if (acc + hist[b] >= half) {
      const binLo = lo + (b / scale);
      const binHi = lo + ((b + 1) / scale);
      const into = half - acc;
      return binLo + ((into / Math.max(1, hist[b])) * (binHi - binLo));
    }
    acc += hist[b];
  }
  return lo;
}

function fillHoles(data: Float32Array, W: number, H: number, iters: number): void {
  const buffers: Float32Array[] = [data, new Float32Array(data.length)];
  let srcIdx = 0;
  for (let it = 0; it < iters; it++) {
    const src = buffers[srcIdx];
    const dst = buffers[1 - srcIdx];
    dst.set(src);
    let holes = 0;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const o = py * W + px;
        if (!Number.isNaN(src[o])) continue;
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = px + dx;
            if (xx < 0 || xx >= W) continue;
            const v = src[yy * W + xx];
            if (!Number.isNaN(v)) {
              sum += v;
              cnt++;
            }
          }
        }
        if (cnt > 0) dst[o] = sum / cnt;
        else holes++;
      }
    }
    srcIdx = 1 - srcIdx;
    if (holes === 0) break;
  }
  if (buffers[srcIdx] !== data) data.set(buffers[srcIdx]);
}

/** 中心差分法向（局部坐标系下，z 分量恒为 1 的未归一化梯度） */
export function heightFieldGradients(hf: HeightField): { gx: Float32Array; gy: Float32Array } {
  const { data, widthPx: W, heightPx: H, pxPerMm } = hf;
  const gx = new Float32Array(W * H);
  const gy = new Float32Array(W * H);
  const inv = 1 / (2 / pxPerMm);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const xl = Math.max(0, x - 1);
      const xr = Math.min(W - 1, x + 1);
      const yu = Math.max(0, y - 1);
      const yd = Math.min(H - 1, y + 1);
      gx[y * W + x] = (data[y * W + xr] - data[y * W + xl]) * inv * (xr === xl ? 2 : 1);
      gy[y * W + x] = (data[yd * W + x] - data[yu * W + x]) * inv * (yd === yu ? 2 : 1);
    }
  }
  return { gx, gy };
}
