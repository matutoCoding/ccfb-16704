// Node 侧流水线性能基准（不依赖浏览器）
import { performance } from 'node:perf_hooks';
import { generateSteleMesh } from '../src/geometry/stele-gen-core.js';
import { fitPlane, toLocal } from '../src/geometry/planeFit.ts';
import { rasterizeHeightField } from '../src/geometry/heightfield.ts';
import { detectRegularGrid as _dg } from '../src/geometry/heightfield.ts';

const t0 = performance.now();
const gen = generateSteleMesh();
console.log('生成网格', (performance.now() - t0).toFixed(0), 'ms', `面 ${gen.indices.length / 3}`);

const t1 = performance.now();
const fit = fitPlane(gen.positions, 3);
console.log('PCA 拟合', (performance.now() - t1).toFixed(0), 'ms', 'RMS=', fit.rmsMm.toFixed(3), 'mm');

const t2 = performance.now();
const local = toLocal({ positions: gen.positions, indices: gen.indices, normals: null, widthMm: 800, heightMm: 1000 }, fit);
console.log('局部变换', (performance.now() - t2).toFixed(0), 'ms');
console.log('规则网格检测:', _dg(local, gen.indices));

// 分阶段计时：直接调用内部各步不可见，改为整体 + 不同分辨率对比
for (const res of [5, 2.5]) {
  const t = performance.now();
  const hf = rasterizeHeightField(local, gen.indices, { pxPerMm: res });
  console.log(`px/mm=${res} HF=${hf.widthPx}x${hf.heightPx} 总耗时`, (performance.now() - t).toFixed(0), 'ms');
}
console.log('全部完成', (performance.now() - t0).toFixed(0), 'ms');
