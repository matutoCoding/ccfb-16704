import type { FitParams } from '../types';

export interface Bounds3 {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

export function computeBounds(positions: Float32Array): Bounds3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

export class FloatArrayBuilder {
  private array: Float32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.array = new Float32Array(capacity);
  }
  push(x: number, y: number, z: number): void {
    if (this.length + 3 > this.array.length) {
      const next = new Float32Array(this.array.length * 2);
      next.set(this.array);
      this.array = next;
    }
    this.array[this.length++] = x;
    this.array[this.length++] = y;
    this.array[this.length++] = z;
  }
  build(): Float32Array {
    return this.array.slice(0, this.length);
  }
}

export class Uint32ArrayBuilder {
  private array: Uint32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.array = new Uint32Array(capacity);
  }
  push(...values: number[]): void {
    if (this.length + values.length > this.array.length) {
      const next = new Uint32Array(Math.max(this.array.length * 2, this.length + values.length));
      next.set(this.array);
      this.array = next;
    }
    for (const value of values) this.array[this.length++] = value;
  }
  build(): Uint32Array {
    return this.array.slice(0, this.length);
  }
}

/** Transform arbitrary scan coordinates so the dominant face is XY and depth is Z. */
export function orientFaceToXY(positions: Float32Array): { positions: Float32Array; bounds: Bounds3 } {
  const n = positions.length / 3;
  const sampleStep = Math.max(1, Math.floor(n / 250_000));
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (let i = 0; i < n; i += sampleStep) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
    count++;
  }
  cx /= count; cy /= count; cz /= count;
  let sxx = 0, syy = 0, szz = 0, sxy = 0, sxz = 0, syz = 0;
  for (let i = 0; i < n; i += sampleStep) {
    const x = positions[i * 3] - cx;
    const y = positions[i * 3 + 1] - cy;
    const z = positions[i * 3 + 2] - cz;
    sxx += x * x; syy += y * y; szz += z * z;
    sxy += x * y; sxz += x * z; syz += y * z;
  }
  const cov = [
    [sxx, sxy, sxz],
    [sxy, syy, syz],
    [sxz, syz, szz],
  ];
  const { values, vectors } = jacobiEigen3(cov);
  const order = [0, 1, 2].sort((a, b) => values[b] - values[a]);
  const vertical = vectors[order[0]];
  const horizontal = vectors[order[1]];
  const normal = vectors[order[2]];
  // Right-handed basis: X=horizontal-ish, Y=vertical, Z=normal.
  let ex = normalize(horizontal);
  const ey0 = normalize(vertical);
  let ez = normalize(normal);
  let ey = cross(ez, ex);
  if (dot(ey, ey0) < 0) {
    ex = ex.map((v) => -v) as [number, number, number];
    ey = ey.map((v) => -v) as [number, number, number];
  }
  if (dot(cross(ex, ey), ez) < 0) ez = ez.map((v) => -v) as [number, number, number];

  const out = new Float32Array(positions.length);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3] - cx;
    const y = positions[i * 3 + 1] - cy;
    const z = positions[i * 3 + 2] - cz;
    out[i * 3] = dot([x, y, z], ex);
    out[i * 3 + 1] = dot([x, y, z], ey);
    out[i * 3 + 2] = dot([x, y, z], ez);
  }
  return { positions: out, bounds: computeBounds(out) };
}

type Vec3 = [number, number, number];

function normalize(v: number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Cyclic Jacobi eigen decomposition for a symmetric 3x3 matrix. */
function jacobiEigen3(matrix: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = matrix.map((row) => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 50; iter++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-10) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const tau = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t);
      const s = t * c;
      const app = a[p][p], aqq = a[q][q], apq = a[p][q];
      a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
      a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
      a[p][q] = a[q][p] = 0;
      for (let k = 0; k < 3; k++) {
        if (k === p || k === q) continue;
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = a[p][k] = c * akp - s * akq;
        a[k][q] = a[q][k] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [
      [v[0][0], v[1][0], v[2][0]],
      [v[0][1], v[1][1], v[2][1]],
      [v[0][2], v[1][2], v[2][2]],
    ],
  };
}

export function baselineAt(fit: FitParams, x: number, y: number): number {
  const u = (x - fit.centerX) / fit.scale;
  const v = (y - fit.centerY) / fit.scale;
  const [c0, c1, c2, c3, c4, c5] = fit.coeffs;
  if (fit.order === 1) return c0 + c1 * u + c2 * v;
  return c0 + c1 * u + c2 * v + c3 * u * u + c4 * u * v + c5 * v * v;
}

export function correctedZAt(fit: FitParams | undefined, x: number, y: number, z: number): number {
  return fit?.corrected ? z - baselineAt(fit, x, y) : z;
}
