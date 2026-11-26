import type { FitParams } from '../types';
import { computeBounds } from './mesh';

/**
 * Robust low-order baseline fit. A quadratic captures slow bow from scanning or
 * an originally slightly curved stone; IRLS prevents intaglio strokes and pits
 * from pulling the reference surface down.
 */
export function fitBaseline(
  positions: Float32Array,
  options: { order?: 1 | 2; robust?: boolean } = {},
): FitParams {
  const order = options.order ?? 2;
  const bounds = computeBounds(positions);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const scale = Math.max((bounds.maxX - bounds.minX) / 2, (bounds.maxY - bounds.minY) / 2, 1);
  const vertexCount = positions.length / 3;
  const stride = Math.max(1, Math.floor(vertexCount / 300_000));

  const basisCount = order === 1 ? 3 : 6;
  let coeffs = new Array(basisCount).fill(0) as number[];
  let weights = sampleWeights(positions, stride, centerX, centerY, scale, coeffs, order, 0);

  for (let iteration = 0; iteration < 4; iteration++) {
    coeffs = solveWeightedFit(positions, stride, centerX, centerY, scale, order, weights);
    if (options.robust === false) break;
    weights = robustWeights(positions, stride, centerX, centerY, scale, coeffs, order);
  }
  if (options.robust === false) {
    coeffs = solveWeightedFit(positions, stride, centerX, centerY, scale, order, null);
  }

  let sumSq = 0;
  let maxAbs = 0;
  let n = 0;
  for (let i = 0; i < vertexCount; i += stride) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const residual = z - evaluate(coeffs, x, y, centerX, centerY, scale, order);
    // Carvings are expected negative. Report the stone-surface fit quality,
    // using an asymmetric robust statistic rather than groove outliers.
    const qualityResidual = residual < 0 ? Math.max(residual, -0.35) : residual;
    sumSq += qualityResidual * qualityResidual;
    maxAbs = Math.max(maxAbs, Math.abs(qualityResidual));
    n++;
  }

  const fullCoeffs: FitParams['coeffs'] =
    order === 1
      ? [coeffs[0], coeffs[1], coeffs[2], 0, 0, 0]
      : [coeffs[0], coeffs[1], coeffs[2], coeffs[3], coeffs[4], coeffs[5]];

  return {
    centerX,
    centerY,
    scale,
    coeffs: fullCoeffs,
    order,
    rmsMm: Math.sqrt(sumSq / Math.max(1, n)),
    maxAbsMm: maxAbs,
    corrected: true,
  };
}

function sampleWeights(
  positions: Float32Array,
  stride: number,
  cx: number,
  cy: number,
  scale: number,
  coeffs: number[],
  order: 1 | 2,
  _iteration: number,
): Float64Array {
  const count = Math.ceil(positions.length / 3 / stride);
  return new Float64Array(count).fill(1);
}

function basis(x: number, y: number, cx: number, cy: number, scale: number, order: 1 | 2): number[] {
  const u = (x - cx) / scale;
  const v = (y - cy) / scale;
  return order === 1 ? [1, u, v] : [1, u, v, u * u, u * v, v * v];
}

function evaluate(
  coeffs: number[],
  x: number,
  y: number,
  cx: number,
  cy: number,
  scale: number,
  order: 1 | 2,
): number {
  const b = basis(x, y, cx, cy, scale, order);
  let value = 0;
  for (let i = 0; i < coeffs.length; i++) value += coeffs[i] * b[i];
  return value;
}

function solveWeightedFit(
  positions: Float32Array,
  stride: number,
  cx: number,
  cy: number,
  scale: number,
  order: 1 | 2,
  weights: Float64Array | null,
): number[] {
  const m = order === 1 ? 3 : 6;
  const ata = Array.from({ length: m }, () => new Float64Array(m));
  const atb = new Float64Array(m);
  let sampleIndex = 0;
  for (let i = 0; i < positions.length / 3; i += stride, sampleIndex++) {
    const b = basis(positions[i * 3], positions[i * 3 + 1], cx, cy, scale, order);
    const z = positions[i * 3 + 2];
    const w = weights ? weights[Math.min(sampleIndex, weights.length - 1)] : 1;
    if (w <= 0.0001) continue;
    for (let r = 0; r < m; r++) {
      atb[r] += w * b[r] * z;
      for (let c = r; c < m; c++) ata[r][c] += w * b[r] * b[c];
    }
  }
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < r; c++) ata[r][c] = ata[c][r];
  }
  return solveLinear(ata.map((row) => Array.from(row)), Array.from(atb));
}

function robustWeights(
  positions: Float32Array,
  stride: number,
  cx: number,
  cy: number,
  scale: number,
  coeffs: number[],
  order: 1 | 2,
): Float64Array {
  const residuals: number[] = [];
  const indexMap: number[] = [];
  let sampleIndex = 0;
  for (let i = 0; i < positions.length / 3; i += stride, sampleIndex++) {
    const z = positions[i * 3 + 2];
    const r = z - evaluate(coeffs, positions[i * 3], positions[i * 3 + 1], cx, cy, scale, order);
    residuals.push(r);
    indexMap.push(sampleIndex);
  }
  const median = quickMedian(residuals);
  const deviations = residuals.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] || 0.05;
  const sigma = Math.max(1.4826 * mad, 0.04);
  const weights = new Float64Array(sampleIndex);
  residuals.forEach((r, i) => {
    // Negative residuals are cuts/pits; apply asymmetric downweighting.
    const standardized = (r - median) / sigma;
    const loss = standardized < -0.35 ? standardized * 1.45 : standardized;
    const k = 4.685;
    const a = Math.min(1, Math.abs(loss) / k);
    weights[indexMap[i]] = (1 - a * a) ** 2;
  });
  return weights;
}

function quickMedian(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const diag = a[col][col] || 1e-12;
    for (let j = col; j < n; j++) a[col][j] /= diag;
    b[col] /= diag;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let j = col; j < n; j++) a[row][j] -= factor * a[col][j];
      b[row] -= factor * b[col];
    }
  }
  return b;
}
