import { uid } from '../db';
import { fitBaseline } from './fit';
import { computeBounds } from './mesh';
import { parseMeshFile, prepareImportedMesh } from './parsers';
import type { ScanRecord } from '../types';

export async function importScanFile(
  file: File,
  steleId: string,
  options: { unit?: 'auto' | 'mm' | 'cm' | 'm'; orient?: boolean; fitOrder?: 1 | 2 } = {},
): Promise<ScanRecord> {
  const buffer = await file.arrayBuffer();
  const parsed = parseMeshFile(file.name, buffer);
  const prepared = prepareImportedMesh(parsed, options.unit ?? 'auto', options.orient ?? true);
  const bounds = computeBounds(prepared.positions);
  const fit = fitBaseline(prepared.positions, { order: options.fitOrder ?? 2, robust: true });
  const now = Date.now();
  return {
    id: uid('scan'),
    steleId,
    name: file.name.replace(/\.(ply|obj)$/i, ''),
    source: prepared.format,
    fileName: file.name,
    note: `导入 ${prepared.format.toUpperCase()}，单位缩放 ×${prepared.unitScale}，已自动摆正并拟合基准面`,
    createdAt: now,
    widthMm: bounds.maxX - bounds.minX,
    heightMm: bounds.maxY - bounds.minY,
    depthMinMm: bounds.minZ,
    depthMaxMm: bounds.maxZ,
    vertexCount: prepared.positions.length / 3,
    faceCount: prepared.indices.length / 3,
    positions: prepared.positions,
    indices: prepared.indices,
    fit,
  };
}
