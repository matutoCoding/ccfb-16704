// 刻口边界几何精度度量：数字拓片笔画边界 vs 网格真值刻口边界
// 指标：双向平均/最大边界偏差(mm)、F1、像素误分率

export interface BinaryMask {
  data: Uint8Array;
  width: number;
  height: number;
}

/** 从位打包的真值文件读取掩膜 */
export function unpackGroundTruth(buffer: ArrayBuffer): { mask: BinaryMask; pxPerMm: number } {
  const head = new Uint32Array(buffer, 0, 4);
  const width = head[0];
  const height = head[1];
  const pxPerMm = head[2] / 1000;
  const total = width * height;
  const packed = new Uint8Array(buffer, 16, Math.ceil(total / 8));
  const data = new Uint8Array(total);
  for (let i = 0; i < total; i++) data[i] = (packed[i >> 3] >> (i & 7)) & 1;
  return { mask: { data, width, height }, pxPerMm };
}

/**
 * 从拓片灰度图提取笔画掩膜：Otsu 自动阈值。
 * 拓片是浅底黑字，暗于阈值即笔画。
 */
export function otsuThreshold(gray: Float32Array): number {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      t = i;
    }
  }
  return t;
}

export function maskFromGray(gray: Float32Array, width: number, height: number): BinaryMask {
  const t = otsuThreshold(gray);
  const data = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) data[i] = gray[i] < t ? 1 : 0;
  return { data, width, height };
}

/** 提取边界像素（掩膜内且 4 邻域存在背景） */
export function boundaryPixels(mask: BinaryMask): Uint8Array {
  const { data, width: W, height: H } = mask;
  const b = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!data[i]) continue;
      if (
        x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
        !data[i - 1] || !data[i + 1] || !data[i - W] || !data[i + W]
      ) {
        b[i] = 1;
      }
    }
  }
  return b;
}

/**
 * 双向边界距离：对预测边界每个像素找真值边界最近距离（Chamfer 距离，两遍扫描）。
 * 返回 { meanMm, maxMm, predCount, gtCount, f1, iou }
 */
export function boundaryAccuracy(
  pred: BinaryMask,
  gt: BinaryMask,
  pxPerMm: number,
): {
  meanMm: number;
  rmsMm: number;
  maxMm: number;
  predBoundary: number;
  gtBoundary: number;
  iou: number;
  f1: number;
  pixelErrorRate: number;
} {
  if (pred.width !== gt.width || pred.height !== gt.height) {
    throw new Error(`掩膜尺寸不一致: ${pred.width}x${pred.height} vs ${gt.width}x${gt.height}`);
  }
  const W = pred.width;
  const H = pred.height;
  const predB = boundaryPixels(pred);
  const gtB = boundaryPixels(gt);

  const chamfer = (src: Uint8Array, dst: Uint8Array): { sum: number; sq: number; max: number; count: number } => {
    const INF = 1e9;
    const dist = new Float32Array(W * H).fill(INF);
    for (let i = 0; i < dst.length; i++) if (dst[i]) dist[i] = 0;
    // 前向
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
        if (y > 0) dist[i] = Math.min(dist[i], dist[i - W] + 1);
        if (x > 0 && y > 0) dist[i] = Math.min(dist[i], dist[i - W - 1] + 1.414);
        if (x < W - 1 && y > 0) dist[i] = Math.min(dist[i], dist[i - W + 1] + 1.414);
      }
    }
    // 后向
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (x < W - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
        if (y < H - 1) dist[i] = Math.min(dist[i], dist[i + W] + 1);
        if (x < W - 1 && y < H - 1) dist[i] = Math.min(dist[i], dist[i + W + 1] + 1.414);
        if (x > 0 && y < H - 1) dist[i] = Math.min(dist[i], dist[i + W - 1] + 1.414);
      }
    }
    let sum = 0;
    let sq = 0;
    let max = 0;
    let count = 0;
    for (let i = 0; i < src.length; i++) {
      if (!src[i]) continue;
      const d = dist[i];
      sum += d;
      sq += d * d;
      if (d > max) max = d;
      count++;
    }
    return { sum, sq, max, count };
  };

  const a = chamfer(predB, gtB);
  const b = chamfer(gtB, predB);
  const sum = a.sum + b.sum;
  const sq = a.sq + b.sq;
  const cnt = a.count + b.count;

  // 混淆矩阵
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < pred.data.length; i++) {
    if (pred.data[i] && gt.data[i]) tp++;
    else if (pred.data[i] && !gt.data[i]) fp++;
    else if (!pred.data[i] && gt.data[i]) fn++;
  }
  const iou = tp / (tp + fp + fn || 1);
  const f1 = (2 * tp) / (2 * tp + fp + fn || 1);
  const pixelErrorRate = (fp + fn) / pred.data.length;

  return {
    meanMm: (sum / (cnt || 1)) / pxPerMm,
    rmsMm: Math.sqrt(sq / (cnt || 1)) / pxPerMm,
    maxMm: a.max / pxPerMm,
    predBoundary: a.count,
    gtBoundary: b.count,
    iou,
    f1,
    pixelErrorRate,
  };
}
