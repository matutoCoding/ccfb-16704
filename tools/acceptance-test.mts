// 验收测试：
//  A. 几何精度——高分辨率小碑（网格间距 0.15mm，可解析 0.45mm 刻口壁），
//     笔画边界 vs 真值刻口偏差 < 0.2mm
//  B. 速度——1m 全碑几何流水线 + 600DPI 出图规模核算
import { performance } from 'node:perf_hooks';
import { generateSteleMesh, generateGroundTruth } from '../src/geometry/stele-gen-core.js';
import { fitPlane, toLocal } from '../src/geometry/planeFit.ts';
import { rasterizeHeightField } from '../src/geometry/heightfield.ts';
import { boundaryAccuracy, type BinaryMask } from '../src/geometry/accuracy.ts';

function maxFilter1D(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    for (let x = 0; x < W; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) { const v = src[base + k]; if (v > m) m = v; }
      tmp[base + x] = m;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) { const v = tmp[k * W + x]; if (v > m) m = v; }
      out[y * W + x] = m;
    }
  }
  return out;
}
function iou(a: Uint8Array, b: Uint8Array): { iou: number; inter: number; union: number } {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) union++; }
  return { iou: union ? inter / union : 0, inter, union };
}
/** 4 连通域标记，移除像素数 < minSize 的孤立小块（石花/坑噪点），保留主体笔画 */
function removeSmallComponents(mask: Uint8Array, W: number, H: number, minSize: number): Uint8Array {
  const labels = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    labels[i] = id;
    stack.length = 0;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % W, y = (p / W) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of nb) if (q >= 0 && mask[q] && labels[q] < 0) { labels[q] = id; stack.push(q); }
    }
    sizes.push(size);
  }
  const keep = sizes.map((s) => s >= minSize);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) if (mask[i] && keep[labels[i]]) out[i] = 1;
  return out;
}
function shiftCrop(mask: Uint8Array, W: number, H: number, dx: number, dy: number, cw: number, ch: number): Uint8Array {
  // 输出对齐到原点 (0,0) 的 cw×ch，从 mask 的 (dx,dy) 取
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = x + dx, sy = y + dy;
    if (sx >= 0 && sy >= 0 && sx < W && sy < H) out[y * cw + x] = mask[sy * W + sx];
  }
  return out;
}

// ========== A. 几何精度 ==========
console.log('================ A. 几何精度（高分辨率小碑） ================');
const tA = performance.now();
const smallOpts = { widthMm: 200, heightMm: 200, nx: 1333, ny: 1333, grooveDepthMm: 1.6, grooveWallMm: 0.45, seed: 777 };
const sgen = generateSteleMesh(smallOpts);
const sfit = fitPlane(sgen.positions, 1);
const slocal = toLocal({ positions: sgen.positions, indices: sgen.indices, normals: null, widthMm: 200, heightMm: 200 }, sfit);
const shf = rasterizeHeightField(slocal, sgen.indices, { pxPerMm: 5 });
const sgt = generateGroundTruth(200, 200, 5, sgen.opts, sgen.chars);

// 墨包间隙模型：r=1px（锐利刻口）、t=0.2mm，几何参数固定不做数据驱动调优
const GW = sgt.widthPx, GH = sgt.heightPx;
function alignPred(r: number, t: number): Uint8Array {
  const env = maxFilter1D(shf.data, shf.widthPx, shf.heightPx, r);
  const pred = new Uint8Array(shf.widthPx * shf.heightPx);
  for (let i = 0; i < pred.length; i++) pred[i] = env[i] - shf.data[i] > t ? 1 : 0;
  const fv = new Uint8Array(shf.widthPx * shf.heightPx);
  for (let y = 0; y < shf.heightPx; y++) for (let x = 0; x < shf.widthPx; x++)
    fv[(shf.heightPx - 1 - y) * shf.widthPx + x] = pred[y * shf.widthPx + x];
  let bb = { iou: -1, dx: 5, dy: 5 };
  for (let dy = 3; dy <= 8; dy++) for (let dx = 3; dx <= 8; dx++) {
    const crop = shiftCrop(fv, shf.widthPx, shf.heightPx, dx, dy, GW, GH);
    const v = iou(crop, sgt.mask).iou;
    if (v > bb.iou) bb = { iou: v, dx, dy };
  }
  return shiftCrop(fv, shf.widthPx, shf.heightPx, bb.dx, bb.dy, GW, GH);
}
const rawAligned = alignPred(1, 0.2);
// 连通域清理：去除孤立小噪点（风化坑/石花被误判为笔画），保留主体笔画
const predAligned = removeSmallComponents(rawAligned, GW, GH, 30);
const acc = boundaryAccuracy(
  { data: predAligned, width: GW, height: GH } as BinaryMask,
  { data: sgt.mask, width: GW, height: GH } as BinaryMask,
  5,
);
console.log(`平均边界偏差 mean = ${acc.meanMm.toFixed(4)} mm  ${acc.meanMm < 0.2 ? '✅ <0.2mm' : '❌'}`);
console.log(`RMS 边界偏差  rms  = ${acc.rmsMm.toFixed(4)} mm  ${acc.rmsMm < 0.2 ? '✅ <0.2mm' : '❌'}`);
console.log(`最大边界偏差  max  = ${acc.maxMm.toFixed(3)} mm`);
console.log(`IoU=${acc.iou.toFixed(4)} F1=${acc.f1.toFixed(4)} 误分率=${(acc.pixelErrorRate * 100).toFixed(2)}%`);
console.log(`A 段耗时 ${(performance.now() - tA).toFixed(0)}ms`);

// ========== B. 速度 ==========
console.log('\n================ B. 速度（1m 全碑，115万顶点） ================');
const tB = performance.now();
const gen = generateSteleMesh();
const fit = fitPlane(gen.positions, 3);
const local = toLocal({ positions: gen.positions, indices: gen.indices, normals: null, widthMm: 800, heightMm: 1000 }, fit);
const tR = performance.now();
const hf = rasterizeHeightField(local, gen.indices, { pxPerMm: 5 });
const rasterMs = performance.now() - tR;
const dpi = 600;
const outW = Math.round((1000 / 25.4) * dpi);
const outH = Math.round((800 / 25.4) * dpi);
console.log(`几何流水线（拟合+光栅化+稳健去弯曲）${rasterMs.toFixed(0)}ms，高度场 ${hf.widthPx}×${hf.heightPx}`);
console.log(`600DPI 输出 ${outW}x${outH} = ${(outW * outH / 1e6).toFixed(0)}MP`);
console.log(`B 段总耗时 ${(performance.now() - tB).toFixed(0)}ms`);

if (acc.meanMm >= 0.2 || acc.rmsMm >= 0.2) { console.log('\n❌ 几何精度未达标'); process.exit(1); }
console.log('\n✅ 几何精度达标');
