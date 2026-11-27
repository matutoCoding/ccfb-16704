// 生成测试碑面数据：binary little-endian PLY + 刻口真值掩膜 + 元数据
// 用法：node tools/generate-stele.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateSteleMesh, generateGroundTruth, defaultSteleOptions } from '../src/geometry/stele-gen-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'testdata');
mkdirSync(outDir, { recursive: true });

const opts = defaultSteleOptions();
console.log('生成碑面网格…', `${opts.nx}x${opts.ny}`);
const t0 = performance.now();
const { positions, indices, chars, pits } = generateSteleMesh(opts);
console.log(`  顶点 ${positions.length / 3}，三角面 ${indices.length / 3}，耗时 ${(performance.now() - t0).toFixed(0)}ms`);

// ---- binary little-endian PLY ----
const vertexCount = positions.length / 3;
const faceCount = indices.length / 3;
const header = [
  'ply',
  'format binary_little_endian 1.0',
  `element vertex ${vertexCount}`,
  'property float x',
  'property float y',
  'property float z',
  `element face ${faceCount}`,
  'property list uchar int vertex_indices',
  'end_header',
  '',
].join('\n');
let headerBytes = new TextEncoder().encode(header);
// 补齐到 4 字节对齐（空格是 PLY 头部合法字符）
const pad = (4 - (headerBytes.length % 4)) % 4;
if (pad) headerBytes = new Uint8Array([...headerBytes, ...new Array(pad).fill(0x20)]);
// 每面：1 字节 count + 3*4 字节索引
const faceBytes = faceCount * 13;
const buf = new ArrayBuffer(headerBytes.length + positions.byteLength + faceBytes);
new Uint8Array(buf, 0, headerBytes.length).set(headerBytes);
new Float32Array(buf, headerBytes.length, positions.length).set(positions);
const faceView = new DataView(buf, headerBytes.length + positions.byteLength);
let off = 0;
for (let f = 0; f < faceCount; f++) {
  faceView.setUint8(off, 3);
  off += 1;
  faceView.setInt32(off, indices[f * 3], true);
  faceView.setInt32(off + 4, indices[f * 3 + 1], true);
  faceView.setInt32(off + 8, indices[f * 3 + 2], true);
  off += 12;
}
const plyPath = join(outDir, 'stele-test.ply');
writeFileSync(plyPath, Buffer.from(buf));
console.log('  写出', plyPath, `${(buf.byteLength / 1048576).toFixed(1)} MB`);

// ---- 刻口真值（5 px/mm，即 0.2mm 采样，与默认高度场同分辨率；位打包掩膜）----
const pxPerMm = 5;
const gt = generateGroundTruth(opts.widthMm, opts.heightMm, pxPerMm, opts, chars);
const gtPath = join(outDir, 'stele-groundtruth.bin');
const total = gt.widthPx * gt.heightPx;
const packed = new Uint8Array(Math.ceil(total / 8));
for (let i = 0; i < total; i++) if (gt.mask[i]) packed[i >> 3] |= 1 << (i & 7);
// 头部：宽、高、pxPerMm*1000、版本号(2=仅位打包掩膜)
const metaBuf = new ArrayBuffer(16);
new Uint32Array(metaBuf, 0, 4).set([gt.widthPx, gt.heightPx, Math.round(gt.pxPerMm * 1000), 2]);
const gtOut = new Uint8Array(16 + packed.length);
gtOut.set(new Uint8Array(metaBuf), 0);
gtOut.set(packed, 16);
writeFileSync(gtPath, gtOut);
console.log('  写出', gtPath, `${gt.widthPx}x${gt.heightPx}`, `${(gtOut.length / 1048576).toFixed(1)} MB`);

// ---- 元数据 ----
const meta = {
  name: '测试碑·永和四海（程序生成）',
  source: 'generated',
  widthMm: opts.widthMm,
  heightMm: opts.heightMm,
  thicknessMm: 120,
  nx: opts.nx,
  ny: opts.ny,
  vertexCount,
  faceCount,
  grooveDepthMm: opts.grooveDepthMm,
  pxPerMm,
  pits,
  characters: chars.map((c) => ({ text: c.text, x: c.x, y: c.y, w: c.w, h: c.h, index: c.index })),
  generatedAt: new Date().toISOString(),
};
writeFileSync(join(outDir, 'stele-meta.json'), JSON.stringify(meta, null, 2));
console.log('完成。');
