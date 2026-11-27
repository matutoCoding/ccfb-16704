import type { HeightField, ScanRecord, TriangleMesh } from '../types';
import { parsePly } from './ply';
import { parseObj } from './obj';
import { fitPlane, toLocal } from './planeFit';
import { rasterizeHeightField } from './heightfield';

export interface ProcessResult {
  mesh: TriangleMesh;
  heightField: HeightField;
  planeRmsMm: number;
}

/** 解析网格文件 */
export async function loadMeshFile(file: File | Blob, name: string): Promise<TriangleMesh> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.ply')) {
    const buf = await file.arrayBuffer();
    return parsePly(buf);
  }
  if (lower.endsWith('.obj')) {
    const text = await file.text();
    return parseObj(text);
  }
  throw new Error('仅支持 PLY / OBJ 格式');
}

/**
 * 完整扫描处理：基准面拟合（去倾斜）→ 局部坐标变换 → 光栅化（二次去弯曲）
 * 几百万面规模下采用采样步长控制 PCA 成本，光栅化为 O(三角面 × 包围盒像素)。
 */
export function processMesh(
  mesh: TriangleMesh,
  pxPerMm: number,
  onProgress?: (stage: string, pct: number) => void,
): ProcessResult {
  onProgress?.('拟合基准面…', 0.05);
  // 顶点超过 50 万时隔点采样做 PCA，精度足够估计法向
  const sampleStep = Math.max(1, Math.floor((mesh.positions.length / 3) / 500000));
  const fit = fitPlane(mesh.positions, sampleStep);

  onProgress?.('变换到基准面坐标系…', 0.15);
  const local = toLocal(mesh, fit);

  onProgress?.('光栅化高度场（去弯曲/补洞）…', 0.25);
  const heightField = rasterizeHeightField(local, mesh.indices, {
    pxPerMm,
    detrend: true,
    onProgress: (p) => onProgress?.('光栅化高度场（去弯曲/补洞）…', 0.25 + p * 0.7),
  });

  onProgress?.('完成', 1);
  return { mesh, heightField, planeRmsMm: fit.rmsMm };
}

export function scanStats(scan: ScanRecord): string {
  return `${(scan.vertexCount / 10000).toFixed(1)}万顶点 · ${(scan.faceCount / 10000).toFixed(1)}万面 · ${scan.widthMm.toFixed(0)}×${scan.heightMm.toFixed(0)}mm`;
}
