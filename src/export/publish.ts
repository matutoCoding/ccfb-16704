import { RubbingEngine, fullRect, type RenderRect } from '../render/RubbingEngine';
import type { CharacterBox, RubbingParams, ScanRecord } from '../types';
import { createGrayscaleTiffWriter, imageDataToGrayscale } from './tiff';
import { createZipBlob, type ZipFile } from './zip';

const MM_PER_INCH = 25.4;

export function dpiToPxPerMm(dpi: number): number {
  return dpi / MM_PER_INCH;
}

export function physicalPixelSize(scan: Pick<ScanRecord, 'widthMm' | 'heightMm'>, dpi: number) {
  const pxPerMm = dpiToPxPerMm(dpi);
  return {
    pxPerMm,
    width: Math.max(1, Math.round(scan.widthMm * pxPerMm)),
    height: Math.max(1, Math.round(scan.heightMm * pxPerMm)),
  };
}

export interface ExportProgress {
  phase: string;
  done: number;
  total: number;
}

export interface TiffExportResult {
  blob: Blob;
  width: number;
  height: number;
  dpi: number;
  elapsedMs: number;
  strips: number;
}

export async function renderWholeTiff(
  scan: ScanRecord,
  params: RubbingParams,
  dpi: number,
  options: { tilePx?: number; editSource?: CanvasImageSource | null; onProgress?: (p: ExportProgress) => void } = {},
): Promise<TiffExportResult> {
  const started = performance.now();
  const requestedTile = options.tilePx ?? 4096;
  const pxPerMm = dpiToPxPerMm(dpi);
  const width = Math.round(scan.widthMm * pxPerMm);
  const height = Math.round(scan.heightMm * pxPerMm);
  const engine = new RubbingEngine();
  // Keep one tile within MAX_TEXTURE_SIZE; 4K tiles cut draw calls substantially.
  const tilePx = Math.max(512, Math.min(requestedTile, engine.maxTextureSize, 4096));
  const rowsPerStrip = tilePx;
  const writer = createGrayscaleTiffWriter(width, height, dpi, rowsPerStrip);
  try {
    engine.setScan(scan);
    engine.setEditSource(options.editSource ?? null);
    const chunks: BlobPart[] = [];
    const totalStrips = writer.stripCount;
    const xTiles = Math.ceil(width / tilePx);
    for (let strip = 0; strip < totalStrips; strip++) {
      const y0 = strip * rowsPerStrip;
      const stripRows = Math.min(rowsPerStrip, height - y0);
      const stripGray = new Uint8Array(width * stripRows);
      for (let tx = 0; tx < xTiles; tx++) {
        const x0 = tx * tilePx;
        const tileW = Math.min(tilePx, width - x0);
        const rect = pixelTileToRect(scan, x0, y0, tileW, stripRows, width, height);
        // Raw WebGL pixels are bottom-up. Convert luminance and flip directly
        // into the top-down TIFF strip, avoiding a second full-size buffer pass.
        const rgba = engine.renderTile(rect, tileW, stripRows, params);
        for (let rawY = 0; rawY < stripRows; rawY++) {
          const dstY = stripRows - 1 - rawY;
          let src = rawY * tileW * 4;
          let dst = dstY * width + x0;
          for (let x = 0; x < tileW; x++, src += 4, dst++) {
            stripGray[dst] = Math.round(0.299 * rgba[src] + 0.587 * rgba[src + 1] + 0.114 * rgba[src + 2]);
          }
        }
        options.onProgress?.({ phase: '渲染 600DPI 分块', done: strip * xTiles + tx + 1, total: totalStrips * xTiles });
        await yieldIfNeeded(tx);
      }
      chunks.push(stripGray as unknown as BlobPart);
      options.onProgress?.({ phase: '编码 TIFF 条带', done: strip + 1, total: totalStrips });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const blob = writer.createBlob(chunks);
    return { blob, width, height, dpi, elapsedMs: performance.now() - started, strips: totalStrips };
  } finally {
    engine.dispose();
  }
}

export function pixelTileToRect(
  scan: Pick<ScanRecord, 'widthMm' | 'heightMm'>,
  x0: number,
  y0: number,
  pixelW: number,
  pixelH: number,
  fullW: number,
  fullH: number,
): RenderRect {
  const pxMmX = scan.widthMm / fullW;
  const pxMmY = scan.heightMm / fullH;
  const xMin = -scan.widthMm / 2 + x0 * pxMmX;
  const xMax = xMin + pixelW * pxMmX;
  const yMax = scan.heightMm / 2 - y0 * pxMmY;
  const yMin = yMax - pixelH * pxMmY;
  return { xMin, xMax, yMin, yMax };
}

export function boxRect(box: CharacterBox): RenderRect {
  return {
    xMin: box.xMm - box.wMm / 2,
    xMax: box.xMm + box.wMm / 2,
    yMin: box.yMm - box.hMm / 2,
    yMax: box.yMm + box.hMm / 2,
  };
}

export function renderBoxCanvas(
  engine: RubbingEngine,
  params: RubbingParams,
  box: CharacterBox,
  dpi: number,
): HTMLCanvasElement {
  const pxPerMm = dpiToPxPerMm(dpi);
  const w = Math.max(1, Math.round(box.wMm * pxPerMm));
  const h = Math.max(1, Math.round(box.hMm * pxPerMm));
  const image = engine.renderImageData(boxRect(box), w, h, params);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas;
}

export async function exportCharacterZip(
  scan: ScanRecord,
  params: RubbingParams,
  boxes: CharacterBox[],
  dpi: number,
  options: { editSource?: CanvasImageSource | null; onProgress?: (p: ExportProgress) => void } = {},
): Promise<{ blob: Blob; count: number; elapsedMs: number }> {
  const started = performance.now();
  const files: ZipFile[] = [];
  const rows: string[] = ['index,label,file,left_mm,top_mm,width_mm,height_mm,center_x_mm,center_y_mm,dpi'];
  const sorted = [...boxes].sort((a, b) => a.index - b.index);
  const engine = new RubbingEngine();
  engine.setScan(scan);
  engine.setEditSource(options.editSource ?? null);
  try {
    for (let i = 0; i < sorted.length; i++) {
      const box = sorted[i];
      const canvas = renderBoxCanvas(engine, params, box, Math.min(dpi, 600));
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('单字 PNG 编码失败'))), 'image/png'),
    );
    const fileName = `${String(box.index).padStart(4, '0')}_${safeName(box.label)}.png`;
    const data = new Uint8Array(await blob.arrayBuffer());
    files.push({ name: `characters/${fileName}`, data });
    const leftMm = box.xMm - box.wMm / 2 + scan.widthMm / 2;
    const topMm = scan.heightMm / 2 - (box.yMm + box.hMm / 2);
    rows.push([
      box.index,
      csvEscape(box.label),
      fileName,
      leftMm.toFixed(3),
      topMm.toFixed(3),
      box.wMm.toFixed(3),
      box.hMm.toFixed(3),
      box.xMm.toFixed(3),
      box.yMm.toFixed(3),
      dpi,
    ].join(','));
    options.onProgress?.({ phase: '导出单字', done: i + 1, total: sorted.length });
    await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    engine.dispose();
  }
  files.push({ name: 'coordinates.csv', data: new TextEncoder().encode('﻿' + rows.join('\n')) });
  files.push({ name: 'coordinates.json', data: new TextEncoder().encode(JSON.stringify({
    coordinateOrigin: 'stele-top-left-mm',
    dpi,
    boxes: sorted.map((b) => ({
      index: b.index, label: b.label,
      leftMm: b.xMm - b.wMm / 2 + scan.widthMm / 2,
      topMm: scan.heightMm / 2 - (b.yMm + b.hMm / 2),
      widthMm: b.wMm, heightMm: b.hMm,
    })),
  }, null, 2)) });
  const blob = await createZipBlob(files);
  return { blob, count: sorted.length, elapsedMs: performance.now() - started };
}

export async function renderCharacterTableTiff(
  scan: ScanRecord,
  params: RubbingParams,
  boxes: CharacterBox[],
  dpi: number,
  options: { editSource?: CanvasImageSource | null; onProgress?: (p: ExportProgress) => void } = {},
): Promise<TiffExportResult> {
  const started = performance.now();
  const sorted = [...boxes].sort((a, b) => a.index - b.index);
  if (!sorted.length) throw new Error('请先框选至少一个单字');
  const cellMmW = Math.max(...sorted.map((b) => b.wMm)) + 18;
  const cellMmH = Math.max(...sorted.map((b) => b.hMm)) + 24;
  const labelMm = 12;
  const cols = Math.min(6, Math.ceil(Math.sqrt(sorted.length * (cellMmW / cellMmH)) * 1.4) || 1);
  const rows = Math.ceil(sorted.length / cols);
  const tableWMm = cols * cellMmW + 20;
  const tableHMm = rows * (cellMmH + labelMm) + 20;
  const pxPerMm = Math.min(dpiToPxPerMm(dpi), 16000 / tableWMm, 16000 / tableHMm);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(tableWMm * pxPerMm);
  canvas.height = Math.round(tableHMm * pxPerMm);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#f4efe3';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(40,32,24,.35)';
  ctx.lineWidth = Math.max(1, pxPerMm * 0.25);
  ctx.fillStyle = '#211a12';
  ctx.font = `${labelMm * 0.52 * pxPerMm}px serif`;
  ctx.textBaseline = 'top';

  const engine = new RubbingEngine();
  engine.setScan(scan);
  engine.setEditSource(options.editSource ?? null);
  try {
    for (let i = 0; i < sorted.length; i++) {
      const box = sorted[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const xMm = 10 + col * cellMmW;
      const yMm = 10 + row * (cellMmH + labelMm);
      const charCanvas = renderBoxCanvas(engine, params, box, pxPerMm * MM_PER_INCH);
      const drawW = box.wMm * pxPerMm;
      const drawH = box.hMm * pxPerMm;
      const dx = Math.round((xMm + (cellMmW - box.wMm) / 2) * pxPerMm);
      const dy = Math.round(yMm * pxPerMm);
      ctx.drawImage(charCanvas, dx, dy, drawW, drawH);
      ctx.strokeRect(dx, dy, drawW, drawH);
      ctx.fillText(`${box.index}. ${box.label}  (${Math.round(box.xMm)},${Math.round(box.yMm)})`, dx, dy + drawH + pxPerMm * 2);
      options.onProgress?.({ phase: '排版单字表', done: i + 1, total: sorted.length });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    engine.dispose();
  }

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = imageDataToGrayscale(image.data, canvas.width, canvas.height);
  const rowsPerStrip = 1024;
  const writer = createGrayscaleTiffWriter(canvas.width, canvas.height, dpi, rowsPerStrip);
  const chunks: BlobPart[] = [];
  for (let y = 0; y < canvas.height; y += rowsPerStrip) {
    const h = Math.min(rowsPerStrip, canvas.height - y);
    chunks.push(gray.subarray(y * canvas.width, (y + h) * canvas.width) as unknown as BlobPart);
  }
  return { blob: writer.createBlob(chunks), width: canvas.width, height: canvas.height, dpi, elapsedMs: performance.now() - started, strips: writer.stripCount };
}

async function yieldIfNeeded(index: number): Promise<void> {
  if (index % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function safeName(label: string): string {
  return label.trim().replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24) || 'untitled';
}

function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export { fullRect };
