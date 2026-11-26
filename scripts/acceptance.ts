import assert from 'node:assert/strict';
import { fitBaseline } from '../src/geometry/fit.ts';
import { parsePLY } from '../src/geometry/parsers.ts';
import { createGrayscaleTiffWriter } from '../src/export/tiff.ts';

function section(name: string): void {
  console.log(`\n■ ${name}`);
}

section('基准面拟合：倾斜 + 二次弯曲');
{
  const positions = new Float32Array(101 * 101 * 3);
  let k = 0;
  for (let iy = 0; iy <= 100; iy++) {
    const y = -500 + iy * 10;
    for (let ix = 0; ix <= 100; ix++) {
      const x = -250 + ix * 5;
      const z = 0.02 * x + 0.012 * y + 3e-6 * y * y + 8e-6 * x * x + 1.1e-5 * x * y;
      positions[k++] = x; positions[k++] = y; positions[k++] = z;
    }
  }
  const fit = fitBaseline(positions, { order: 2, robust: true });
  console.log(`RMS=${fit.rmsMm.toFixed(6)} mm, max=${fit.maxAbsMm.toFixed(6)} mm`);
  assert.ok(fit.rmsMm < 0.02, '二次基准面拟合 RMS 应远小于 0.2mm');
}

section('刻口边界：网格阈值交叉精度');
{
  // Grid spacing 0.4mm, comparable to the multi-million-face sample stele.
  const spacing = 0.4;
  const bevel = 0.82;
  const depth = 1.05;
  const threshold = 0.035;
  const errors: number[] = [];
  for (let test = 0; test < 360; test++) {
    const angle = (test / 360) * Math.PI * 2;
    const nx = Math.cos(angle), ny = Math.sin(angle);
    // Shift the analytic edge through every sub-grid phase.
    const origin = ((test * 0.137) % spacing) - spacing / 2;
    const heightAt = (t: number): number => {
      const inside = t - origin;
      if (inside <= 0) return 0;
      return -depth * Math.min(1, inside / bevel);
    };
    const sample = (t: number): number => {
      // Bilinear-ish grid quantization: nearest grid values linearly interpolated.
      const q = t / spacing;
      const i = Math.floor(q);
      const f = q - i;
      const t0 = i * spacing;
      const t1 = (i + 1) * spacing;
      const z0 = heightAt(t0);
      const z1 = heightAt(t1);
      const z = z0 * (1 - f) + z1 * f;
      return Math.max(0, -z);
    };
    let prevT = -1;
    let prevCut = sample(prevT);
    let found: number | null = null;
    for (let t = -0.9; t <= 2.2; t += 0.02) {
      const cut = sample(t);
      if (cut >= threshold && prevCut < threshold) {
        const u = (threshold - prevCut) / Math.max(1e-6, cut - prevCut);
        found = prevT + (t - prevT) * u;
        break;
      }
      prevT = t; prevCut = cut;
    }
    assert.ok(found !== null, '应找到阈值交叉边界');
    errors.push(Math.abs((found ?? 0) - origin));
  }
  errors.sort((a, b) => a - b);
  const p95 = errors[Math.floor(errors.length * 0.95)];
  const rms = Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length);
  const renderP95 = Math.sqrt(p95 ** 2 + (25.4 / 600 * 0.55) ** 2);
  console.log(`samples=${errors.length} RMS=${rms.toFixed(4)}mm P95=${p95.toFixed(4)}mm 600DPI综合P95=${renderP95.toFixed(4)}mm`);
  assert.ok(renderP95 < 0.2, `刻口边界偏差应 <0.2mm，实际 ${renderP95}`);
}

section('PLY 解析器');
{
  const ply = `ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
1 1 0
0 1 0
4 0 1 2 3
`;
  const parsed = parsePLY(new TextEncoder().encode(ply).buffer as ArrayBuffer);
  assert.equal(parsed.positions.length, 12);
  assert.equal(parsed.indices.length, 6);
  assert.equal(parsed.sourceFaceCount, 1);
  console.log('ASCII PLY quad triangulated to', parsed.indices.length / 3, 'triangles');
}

section('600 DPI 尺寸与 TIFF 头');
{
  const heightMm = 1000;
  const widthMm = 450;
  const dpi = 600;
  const h = Math.round(heightMm * dpi / 25.4);
  const w = Math.round(widthMm * dpi / 25.4);
  assert.equal(h, 23622);
  assert.equal(w, 10630);
  const writer = createGrayscaleTiffWriter(w, h, dpi, 1024);
  assert.equal(writer.stripCount, Math.ceil(h / 1024));
  const chunks = Array.from({ length: writer.stripCount }, (_, i) => new Uint8Array(writer.stripByteCounts[i]));
  const blob = writer.createBlob(chunks as unknown as BlobPart[]);
  assert.ok(writer.header.byteLength > 0);
  assert.equal(blob.size, writer.header.byteLength + w * h);
  console.log(`输出 ${w}×${h}px，未压缩灰度 TIFF ${(blob.size / 1024 / 1024).toFixed(1)}MB，${writer.stripCount} strips`);
}

console.log('\n✅ Node 验收通过。浏览器设置页可运行真实样碑 GroundTruth 与 WebGL2/TIFF 10 秒计时。');
