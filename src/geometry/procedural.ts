import { uid } from '../db';
import { fitBaseline } from './fit';
import { computeBounds } from './mesh';
import type { GlyphTruth, GroundTruth, PitTruth, ScanRecord } from '../types';

export interface ProceduralOptions {
  steleId: string;
  id?: string;
  name?: string;
  seed?: number;
  widthMm?: number;
  heightMm?: number;
  nx?: number;
  ny?: number;
  glyphSize?: number;
  extraDamage?: boolean;
  createdAt?: number;
}

const COLUMN_TEXT = [
  '碑林藏石墨',
  '拓影走龙蛇',
  '千载风雨迹',
  '一刀一画真',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PreparedGlyph {
  truth: GlyphTruth;
  distance: Float32Array;
  boxMm: number;
}

export function createProceduralScan(options: ProceduralOptions): ScanRecord {
  const widthMm = options.widthMm ?? 450;
  const heightMm = options.heightMm ?? 1000;
  const nx = options.nx ?? 900;
  const ny = options.ny ?? 2000;
  const maskSize = options.glyphSize ?? 1024;
  const seed = options.seed ?? 20261127;
  const random = mulberry32(seed);

  const glyphs = createGlyphs(maskSize, widthMm, heightMm);
  const prepared: PreparedGlyph[] = glyphs.map((truth) => ({
    truth,
    boxMm: truth.wMm,
    distance: insideDistanceMm(truth.mask, maskSize, truth.wMm),
  }));

  const vertexCount = (nx + 1) * (ny + 1);
  const positions = new Float32Array(vertexCount * 3);
  const dx = widthMm / nx;
  const dy = heightMm / ny;

  for (let j = 0; j <= ny; j++) {
    const y = -heightMm / 2 + j * dy;
    for (let i = 0; i <= nx; i++) {
      const x = -widthMm / 2 + i * dx;
      const idx = j * (nx + 1) + i;
      let z = baseDeformation(x, y, widthMm, heightMm);

      for (const g of prepared) {
        const carve = sampleGlyphCarve(g, x, y);
        if (carve > 0) z -= carve;
      }
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
    }
  }

  const pits = createPits(widthMm, heightMm, random, options.extraDamage ?? false);
  applyPits(positions, nx, ny, widthMm, heightMm, pits);

  const indices = new Uint32Array(nx * ny * 6);
  let k = 0;
  const row = nx + 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }

  const bounds = computeBounds(positions);
  const fit = fitBaseline(positions, { order: 2, robust: true });
  const groundTruth: GroundTruth = {
    widthMm,
    heightMm,
    glyphs,
    pits,
    nominalEdgeToleranceMm: 0.2,
    generatedAt: options.createdAt ?? Date.now(),
  };

  return {
    id: options.id ?? uid('scan'),
    steleId: options.steleId,
    name: options.name ?? (options.extraDamage ? '复测扫描 · 含新增泐损' : '初刻程序扫描'),
    source: 'procedural',
    note: '程序生成的阴刻楷书、基准弯曲、石花与风化坑网格',
    createdAt: options.createdAt ?? Date.now(),
    widthMm,
    heightMm,
    depthMinMm: bounds.minZ,
    depthMaxMm: bounds.maxZ,
    vertexCount,
    faceCount: nx * ny * 2,
    positions,
    indices,
    grid: { nx, ny },
    fit,
    groundTruth,
    seed,
  };
}

export function addFreshDamage(scan: ScanRecord): ScanRecord {
  if (!scan.grid || !scan.groundTruth) {
    throw new Error('仅程序样例扫描可直接追加复测损伤');
  }
  const positions = scan.positions.slice();
  const random = mulberry32((scan.seed ?? 1) + 991);
  const extra = createPits(scan.widthMm, scan.heightMm, random, true).filter((p) => p.kind === 'new-damage');
  applyPits(positions, scan.grid.nx, scan.grid.ny, scan.widthMm, scan.heightMm, extra);
  return {
    ...scan,
    id: uid('scan'),
    name: '复测扫描 · 含新增泐损',
    createdAt: Date.now(),
    positions,
    indices: scan.indices,
    groundTruth: {
      ...scan.groundTruth,
      pits: [...scan.groundTruth.pits, ...extra],
    },
  };
}

function baseDeformation(x: number, y: number, w: number, h: number): number {
  const tiltX = 0.018 * x;
  const tiltY = 0.011 * y;
  // Predominantly quadratic bow/twist, exactly representable by the datum fit,
  // with only a small residual low-frequency scan undulation.
  const bowY = 3.2e-6 * y * y - 0.55;
  const bowX = 9.0e-6 * x * x - 0.45;
  const twist = 1.2e-5 * x * y;
  const scanRipple = 0.07 * Math.sin(y / 260 + x / 310);
  void w; void h;
  return tiltX + tiltY + bowY + bowX + twist + scanRipple;
}

function createGlyphs(maskSize: number, widthMm: number, heightMm: number): GlyphTruth[] {
  const glyphs: GlyphTruth[] = [];
  const boxMm = 108;
  const topY = heightMm / 2 - 165;
  const rowPitch = 158;
  const rightX = widthMm / 2 - 82;
  const colPitch = 103;
  let index = 1;
  for (let col = 0; col < COLUMN_TEXT.length; col++) {
    const text = COLUMN_TEXT[col];
    const cx = rightX - col * colPitch;
    for (let row = 0; row < text.length; row++) {
      const cy = topY - row * rowPitch;
      const mask = renderGlyphMask(text[row], maskSize);
      glyphs.push({
        id: `glyph_${index}`,
        index,
        char: text[row],
        xMm: cx,
        yMm: cy,
        wMm: boxMm,
        hMm: boxMm,
        maskSize,
        mask,
      });
      index++;
    }
  }
  return glyphs;
}

function renderGlyphMask(char: string, size: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建字形 Canvas 2D 上下文');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontSize = Math.round(size * 0.80);
  ctx.font = `700 ${fontSize}px "KaiTi","STKaiti","Kaiti SC","DFKai-SB","SimKai","Noto Serif CJK SC","Source Han Serif SC",serif`;
  ctx.fillText(char, size / 2, size / 2 + size * 0.035, size * 0.9);
  const data = ctx.getImageData(0, 0, size, size).data;
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3];
  return mask;
}

/** Exact squared Euclidean distance transform; returned values are millimeters. */
function insideDistanceMm(mask: Uint8Array, size: number, boxMm: number): Float32Array {
  const n = size * size;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = mask[i] > 110 ? 1 : 0;
  const dist = new Float64Array(n);
  const INF = 1e18;
  for (let i = 0; i < n; i++) dist[i] = inside[i] ? INF : 0;

  // Horizontal 1D EDT.
  const f = new Float64Array(size);
  const dRow = new Float64Array(size);
  for (let y = 0; y < size; y++) {
    const off = y * size;
    for (let x = 0; x < size; x++) f[x] = dist[off + x];
    edt1d(f, dRow, size);
    for (let x = 0; x < size; x++) dist[off + x] = dRow[x];
  }
  // Vertical 1D EDT on transposed columns.
  const col = new Float64Array(size);
  const outCol = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) col[y] = dist[y * size + x];
    edt1d(col, outCol, size);
    for (let y = 0; y < size; y++) dist[y * size + x] = outCol[y];
  }

  const result = new Float32Array(n);
  const pxMm = boxMm / size;
  for (let i = 0; i < n; i++) result[i] = Math.sqrt(Math.max(0, dist[i])) * pxMm;
  return result;
}

function edt1d(f: Float64Array, d: Float64Array, n: number): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const delta = q - v[k];
    d[q] = delta * delta + f[v[k]];
  }
}

function sampleGlyphCarve(g: PreparedGlyph, x: number, y: number): number {
  const half = g.boxMm / 2;
  const lx = x - (g.truth.xMm - half);
  const lyTop = g.truth.yMm + half - y; // mask row down
  if (lx < 0 || lx >= g.boxMm || lyTop < 0 || lyTop >= g.boxMm) return 0;
  const s = g.truth.maskSize;
  const fx = (lx / g.boxMm) * (s - 1);
  const fy = (lyTop / g.boxMm) * (s - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const x1 = Math.min(s - 1, x0 + 1), y1 = Math.min(s - 1, y0 + 1);
  const d00 = g.distance[y0 * s + x0];
  const d10 = g.distance[y0 * s + x1];
  const d01 = g.distance[y1 * s + x0];
  const d11 = g.distance[y1 * s + x1];
  const inside = (d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty;
  if (inside <= 0.0001) return 0;
  const bevel = 0.82;
  // Near-linear bevel starts at the mouth; a very small threshold therefore
  // locates the true cut edge without the large inward bias of a wide S-curve.
  const profile = Math.min(1, inside / bevel);
  // Slight V/U variation makes strokes look cut rather than stamped.
  const depth = 0.92 + 0.22 * Math.sin(g.truth.index * 1.73);
  return depth * profile * (0.9 + 0.1 * Math.min(1, inside / 3));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function createPits(w: number, h: number, random: () => number, extraDamage: boolean): PitTruth[] {
  const pits: PitTruth[] = [];
  for (let i = 0; i < 230; i++) {
    const r = 1.2 + random() ** 2 * 8.5;
    pits.push({
      x: (random() - 0.5) * (w - 24),
      y: (random() - 0.5) * (h - 36),
      r,
      depth: 0.08 + random() * 0.55 * (r / 9),
      kind: 'pit',
    });
  }
  for (let i = 0; i < 34; i++) {
    pits.push({
      x: (random() - 0.5) * (w - 50),
      y: (random() - 0.5) * (h - 70),
      r: 7 + random() * 20,
      depth: 0.16 + random() * 0.82,
      kind: 'spall',
    });
  }
  if (extraDamage) {
    // Fresh losses concentrated around several later-damaged characters.
    const centers = [
      { x: 58, y: 151 }, { x: -45, y: -165 }, { x: -148, y: -7 },
    ];
    centers.forEach((c, ci) => {
      for (let i = 0; i < 18; i++) {
        const angle = random() * Math.PI * 2;
        const radius = random() * 38;
        pits.push({
          x: c.x + Math.cos(angle) * radius,
          y: c.y + Math.sin(angle) * radius * 0.8,
          r: 2 + random() * (ci === 0 ? 10 : 7),
          depth: 0.22 + random() * 0.72,
          kind: 'new-damage',
        });
      }
    });
  }
  return pits;
}

function applyPits(
  positions: Float32Array,
  nx: number,
  ny: number,
  widthMm: number,
  heightMm: number,
  pits: PitTruth[],
): void {
  const dx = widthMm / nx;
  const dy = heightMm / ny;
  const row = nx + 1;
  for (const pit of pits) {
    const i0 = Math.max(0, Math.floor((pit.x - pit.r * 1.35 + widthMm / 2) / dx));
    const i1 = Math.min(nx, Math.ceil((pit.x + pit.r * 1.35 + widthMm / 2) / dx));
    const j0 = Math.max(0, Math.floor((pit.y - pit.r * 1.35 + heightMm / 2) / dy));
    const j1 = Math.min(ny, Math.ceil((pit.y + pit.r * 1.35 + heightMm / 2) / dy));
    const phase1 = pit.x * 0.13 + pit.y * 0.07;
    const phase2 = pit.y * 0.17 - pit.x * 0.05;
    for (let j = j0; j <= j1; j++) {
      const y = -heightMm / 2 + j * dy;
      for (let i = i0; i <= i1; i++) {
        const x = -widthMm / 2 + i * dx;
        const rx = (x - pit.x) / pit.r;
        const ry = (y - pit.y) / pit.r;
        const angle = Math.atan2(ry, rx);
        const irregular = 1 + 0.22 * Math.sin(angle * 5 + phase1) + 0.13 * Math.sin(angle * 9 + phase2);
        const rn = Math.hypot(rx, ry) / irregular;
        if (rn >= 1) continue;
        let bowl: number;
        if (pit.kind === 'spall') {
          bowl = pit.depth * (1 - smoothstep(0.72, 1, rn));
          if (rn < 0.72) bowl = pit.depth * (0.82 + 0.18 * Math.sin(x * 1.7 + y * 0.9));
        } else {
          bowl = pit.depth * (1 - smoothstep(0.42, 1, rn));
        }
        const idx = j * row + i;
        positions[idx * 3 + 2] -= Math.max(0, bowl);
      }
    }
  }
}
