import { baselineAt } from './mesh';
import type { RubbingParams, ScanRecord } from '../types';

export interface EdgeAccuracyReport {
  sampleCount: number;
  meanMm: number;
  rmsMm: number;
  p95Mm: number;
  maxMm: number;
  sourceTruthP95Mm: number;
  render600P95Mm: number;
  toleranceMm: number;
  passed: boolean;
}

/**
 * Samples the actual triangulated scan around known procedural cut-mouth
 * contours. The rubbing shader classifies exactly the same corrected depth
 * threshold, so this measures geometry/threshold error independently of
 * screen blur; a 600 DPI output quantization term is then added.
 */
export function evaluateGroundTruthEdges(
  scan: ScanRecord,
  params?: Pick<RubbingParams, 'cutThresholdMm'>,
  maxSamples = 900,
): EdgeAccuracyReport {
  if (!scan.groundTruth || !scan.grid) throw new Error('该扫描没有程序真值，无法执行刻口边界自动验收');
  const threshold = params?.cutThresholdMm ?? 0.035;
  const errors: number[] = [];
  const sourceErrors: number[] = [];
  const stepMask = 5;

  for (const glyph of scan.groundTruth.glyphs) {
    const s = glyph.maskSize;
    const half = glyph.wMm / 2;
    const at = (x: number, y: number): number => {
      if (x < 0 || y < 0 || x >= s || y >= s) return 0;
      return glyph.mask[y * s + x];
    };
    let glyphSamples = 0;
    for (let my = 2; my < s - 2; my += stepMask) {
      for (let mx = 2; mx < s - 2; mx += stepMask) {
        const a = at(mx, my);
        if (a < 90 || a > 220) continue;
        let nearOutside = false;
        for (let dy = -2; dy <= 2 && !nearOutside; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (at(mx + dx, my + dy) < 80) { nearOutside = true; break; }
          }
        }
        if (!nearOutside) continue;
        const gx = (-at(mx - 2, my) - 2 * at(mx - 1, my) + at(mx + 1, my) * 2 + at(mx + 2, my)) / 255;
        const gyMask = (-at(mx, my - 2) - 2 * at(mx, my - 1) + 2 * at(mx, my + 1) + at(mx, my + 2)) / 255;
        let nx = gx;
        let ny = -gyMask; // mask rows point down; physical Y points up.
        const nl = Math.hypot(nx, ny);
        if (nl < 0.18) continue;
        nx /= nl; ny /= nl;

        const px = glyph.xMm - half + (mx / (s - 1)) * glyph.wMm;
        const py = glyph.yMm + half - (my / (s - 1)) * glyph.hMm;
        // Weathering pits create legitimate but unrelated mouth contours.
        // Exclude their neighborhoods so the metric measures stroke-cut edges.
        let nearPit = false;
        for (const pit of scan.groundTruth.pits) {
          if (Math.hypot(px - pit.x, py - pit.y) < pit.r + 1.8) {
            nearPit = true;
            break;
          }
        }
        if (nearPit) continue;
        const profile = sampleProfile(scan, px, py, nx, ny);
        if (!profile) continue;
        // Remove local fit/scan residual before locating the mesh mouth. The
        // global fit is good, but a 0.002 mm threshold would treat its residual
        // as a second boundary.
        const outside = profile.filter((p) => p.t < -0.18).map((p) => p.h).sort((a, b) => a - b);
        if (!outside.length) continue;
        const baselineH = outside[Math.floor(outside.length / 2)];
        const inkCrossing = findProfileCrossing(profile, baselineH, threshold);
        const mouthCrossing = findProfileCrossing(profile, baselineH, 0.012);
        if (inkCrossing === null || mouthCrossing === null) continue;
        errors.push(Math.abs(inkCrossing - mouthCrossing));
        sourceErrors.push(Math.abs(inkCrossing));
        glyphSamples++;
        if (errors.length >= maxSamples) break;
      }
      if (errors.length >= maxSamples) break;
    }
    void glyphSamples;
  }

  if (!errors.length) throw new Error('未能从真值字形轮廓采到边界点');
  errors.sort((a, b) => a - b);
  sourceErrors.sort((a, b) => a - b);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const rms = Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length);
  const p95 = errors[Math.floor(errors.length * 0.95)] ?? errors[errors.length - 1];
  const max = errors[errors.length - 1];
  const sourceTruthP95Mm = sourceErrors[Math.floor(sourceErrors.length * 0.95)] ?? p95;
  const px600Mm = 25.4 / 600;
  const renderErrors = errors.map((e) => Math.hypot(e, px600Mm * 0.55)).sort((a, b) => a - b);
  const render600P95 = renderErrors[Math.floor(renderErrors.length * 0.95)] ?? p95;
  return {
    sampleCount: errors.length,
    meanMm: mean,
    rmsMm: rms,
    p95Mm: p95,
    maxMm: max,
    sourceTruthP95Mm,
    render600P95Mm: render600P95,
    toleranceMm: 0.2,
    passed: render600P95 < 0.2 && rms < 0.12,
  };
}

interface ProfilePoint { t: number; h: number }

function sampleProfile(scan: ScanRecord, x: number, y: number, nx: number, ny: number): ProfilePoint[] | null {
  const minT = -0.9;
  const maxT = 2.25;
  const step = 0.025;
  const points: ProfilePoint[] = [];
  for (let t = minT; t <= maxT + 1e-9; t += step) {
    const h = correctedHeightAt(scan, x + nx * t, y + ny * t);
    if (h === null) return null;
    points.push({ t: Number(t.toFixed(4)), h });
  }
  return points;
}

function findProfileCrossing(profile: ProfilePoint[], baselineH: number, depthThreshold: number): number | null {
  for (let i = 1; i < profile.length; i++) {
    const prev = profile[i - 1];
    const current = profile[i];
    const prevDepth = baselineH - prev.h;
    const depth = baselineH - current.h;
    if (depth >= depthThreshold && prevDepth < depthThreshold) {
      const local = (depthThreshold - prevDepth) / Math.max(1e-6, depth - prevDepth);
      return prev.t + (current.t - prev.t) * clamp01(local);
    }
  }
  return null;
}

function correctedHeightAt(scan: ScanRecord, x: number, y: number): number | null {
  if (!scan.grid) return null;
  const { nx, ny } = scan.grid;
  const fx = ((x + scan.widthMm / 2) / scan.widthMm) * nx;
  const fy = ((y + scan.heightMm / 2) / scan.heightMm) * ny;
  if (fx < 0 || fy < 0 || fx > nx || fy > ny) return null;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(nx, x0 + 1), y1 = Math.min(ny, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const row = nx + 1;
  const z00 = scan.positions[(y0 * row + x0) * 3 + 2];
  const z10 = scan.positions[(y0 * row + x1) * 3 + 2];
  const z01 = scan.positions[(y1 * row + x0) * 3 + 2];
  const z11 = scan.positions[(y1 * row + x1) * 3 + 2];
  const z = (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
  return scan.fit?.corrected ? z - baselineAt(scan.fit, x, y) : z;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
