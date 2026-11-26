import type { DiffRegion, DiffSummary, RegistrationTransform } from '../types';
import { uid } from '../db';

export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

export function imageDataToGray(image: ImageData): GrayImage {
  const data = new Float32Array(image.width * image.height);
  for (let p = 0, i = 0; p < data.length; p++, i += 4) {
    data[p] = (0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2]) / 255;
  }
  return { width: image.width, height: image.height, data };
}

export function canvasToGray(canvas: HTMLCanvasElement): GrayImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return imageDataToGray(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

export function makeCanvasFromImage(image: HTMLImageElement | HTMLCanvasElement, maxSize = 760): HTMLCanvasElement {
  const sw = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const sh = 'naturalHeight' in image ? image.naturalHeight : image.height;
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function features(gray: GrayImage): Float32Array {
  const { width: w, height: h, data } = gray;
  const out = new Float32Array(w * h);
  let max = 1e-6;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = data[i + 1] - data[i - 1];
      const gy = data[i + w] - data[i - w];
      const v = Math.hypot(gx, gy);
      out[i] = v;
      if (v > max) max = v;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i] / (max * 0.45));
  return out;
}

interface SearchTransform {
  logScale: number;
  rotation: number;
  tx: number;
  ty: number;
}

export function registerGray(source: GrayImage, target: GrayImage): RegistrationTransform {
  const sf = features(source);
  const tf = features(target);
  const baseScale = Math.min(target.width / source.width, target.height / source.height) * 0.98;
  const centerS = { x: source.width / 2, y: source.height / 2 };
  const centerT = { x: target.width / 2, y: target.height / 2 };

  const sample = (p: SearchTransform, x: number, y: number): number => {
    const scale = baseScale * Math.exp(p.logScale);
    const dx = x - (centerT.x + p.tx);
    const dy = y - (centerT.y + p.ty);
    const c = Math.cos(-p.rotation);
    const s = Math.sin(-p.rotation);
    const sx = (c * dx - s * dy) / scale + centerS.x;
    const sy = (s * dx + c * dy) / scale + centerS.y;
    return bilinear(sf, source.width, source.height, sx, sy);
  };

  const score = (p: SearchTransform): number => {
    let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0, n = 0;
    const step = target.width > 420 ? 2 : 1;
    for (let y = 0; y < target.height; y += step) {
      for (let x = 0; x < target.width; x += step) {
        const b = tf[y * target.width + x];
        const a = sample(p, x, y);
        if (a === 0 && b < 0.04) continue;
        n++;
        sumA += a; sumB += b;
        sumAA += a * a; sumBB += b * b; sumAB += a * b;
      }
    }
    if (n < 100) return 1e9;
    const cov = sumAB - (sumA * sumB) / n;
    const va = sumAA - (sumA * sumA) / n;
    const vb = sumBB - (sumB * sumB) / n;
    const ncc = cov / Math.sqrt(Math.max(1e-6, va * vb));
    return 1 - Math.max(-1, Math.min(1, ncc));
  };

  let best: SearchTransform = { logScale: 0, rotation: 0, tx: 0, ty: 0 };
  let bestScore = score(best);
  let steps = [0.10, 0.10, target.width * 0.07, target.height * 0.07];
  for (let round = 0; round < 7; round++) {
    let improved = true;
    while (improved) {
      improved = false;
      const candidates: SearchTransform[] = [];
      for (let dim = 0; dim < 4; dim++) {
        for (const sign of [-1, 1]) {
          const next = { ...best };
          const key = (['logScale', 'rotation', 'tx', 'ty'] as const)[dim];
          next[key] += steps[dim] * sign;
          candidates.push(next);
        }
      }
      for (const candidate of candidates) {
        const value = score(candidate);
        if (value < bestScore - 1e-5) {
          best = candidate;
          bestScore = value;
          improved = true;
        }
      }
    }
    steps = steps.map((v) => v * 0.52);
  }

  const absoluteScale = baseScale * Math.exp(best.logScale);
  return {
    scale: absoluteScale,
    rotationDeg: (best.rotation * 180) / Math.PI,
    tx: best.tx,
    ty: best.ty,
    score: Math.max(0, 1 - bestScore),
    width: target.width,
    height: target.height,
  };
}

export function scaleTransform(t: RegistrationTransform, factor: number): RegistrationTransform {
  return { ...t, scale: t.scale * factor, tx: t.tx * factor, ty: t.ty * factor, width: Math.round(t.width * factor), height: Math.round(t.height * factor) };
}

export function warpGray(source: GrayImage, width: number, height: number, t: RegistrationTransform): Float32Array {
  const out = new Float32Array(width * height);
  const csx = source.width / 2;
  const csy = source.height / 2;
  const ctx = width / 2;
  const cty = height / 2;
  const rot = (-t.rotationDeg * Math.PI) / 180;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - (ctx + t.tx);
      const dy = y - (cty + t.ty);
      const sx = (c * dx - s * dy) / t.scale + csx;
      const sy = (s * dx + c * dy) / t.scale + csy;
      out[y * width + x] = bilinear(source.data, source.width, source.height, sx, sy);
    }
  }
  return out;
}

export function drawAlignedImage(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  t: RegistrationTransform,
  alpha = 1,
): void {
  const factor = targetWidth / t.width;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(targetWidth / 2 + t.tx * factor, targetHeight / 2 + t.ty * factor);
  ctx.rotate((t.rotationDeg * Math.PI) / 180);
  const scale = t.scale * factor;
  ctx.scale(scale, scale);
  ctx.drawImage(source, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
  ctx.restore();
}

function bilinear(data: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export function computeDiff(digital: GrayImage, oldAligned: Float32Array, registrationScore: number): DiffSummary & {
  width: number;
  height: number;
  newMask: Uint8Array;
  oldOnlyMask: Uint8Array;
} {
  const w = digital.width, h = digital.height;
  const digitalThreshold = otsu(digital.data);
  const oldThreshold = otsu(oldAligned);
  const dMask = new Uint8Array(w * h);
  const oMask = new Uint8Array(w * h);
  for (let i = 0; i < dMask.length; i++) {
    dMask[i] = digital.data[i] > digitalThreshold ? 1 : 0;
    oMask[i] = oldAligned[i] > oldThreshold ? 1 : 0;
  }
  const oldTol = dilate(oMask, w, h, 2);
  const newRaw = new Uint8Array(w * h);
  const oldTolD = dilate(dMask, w, h, 2);
  const oldOnlyRaw = new Uint8Array(w * h);
  let newPixels = 0, oldPixels = 0;
  for (let i = 0; i < w * h; i++) {
    if (dMask[i] && !oldTol[i]) { newRaw[i] = 1; newPixels++; }
    if (oMask[i] && !oldTolD[i]) { oldOnlyRaw[i] = 1; oldPixels++; }
  }
  const newRegions = connectedRegions(newRaw, w, h, 'new-loss', 24);
  const oldRegions = connectedRegions(oldOnlyRaw, w, h, 'old-loss', 42);
  const regions = [...newRegions, ...oldRegions].sort((a, b) => b.severity - a.severity).slice(0, 80);
  return {
    score: registrationScore,
    newLossPixels: newPixels,
    oldOnlyPixels: oldPixels,
    regions,
    alignedAt: Date.now(),
    width: w,
    height: h,
    newMask: newRaw,
    oldOnlyMask: oldOnlyRaw,
  };
}

function otsu(data: Float32Array): number {
  const hist = new Float64Array(256);
  for (const v of data) hist[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 0.5;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t / 255;
    }
  }
  return threshold;
}

function dilate(mask: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let current = mask;
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (current[i]) { next[i] = 1; continue; }
        let found = 0;
        for (let dy = -1; dy <= 1 && !found; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && current[yy * w + xx]) {
              found = 1;
              break;
            }
          }
        }
        next[i] = found;
      }
    }
    current = next;
  }
  return current;
}

function connectedRegions(mask: Uint8Array, w: number, h: number, kind: DiffRegion['kind'], minArea: number): DiffRegion[] {
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const regions: DiffRegion[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0, sx = 0, sy = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p / w) | 0;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const neighbors = [p - 1, p + 1, p - w, p + w];
      for (let n = 0; n < 4; n++) {
        const q = neighbors[n];
        if (q < 0 || q >= mask.length || visited[q] || !mask[q]) continue;
        if (n < 2 && ((q % w === 0 && p % w === w - 1) || (p % w === 0 && q % w === w - 1))) continue;
        visited[q] = 1;
        stack[sp++] = q;
      }
    }
    if (area < minArea) continue;
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    regions.push({
      id: uid('diff'),
      x: minX / w,
      y: minY / h,
      w: boxW / w,
      h: boxH / h,
      area,
      severity: Math.min(1, area / (w * h * 0.01)) * 0.6 + Math.min(1, (boxW * boxH) / (w * h * 0.08)) * 0.4,
      centroidX: sx / area / w,
      centroidY: sy / area / h,
      kind,
    });
  }
  return regions;
}
