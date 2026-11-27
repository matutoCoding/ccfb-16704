// 全局类型定义：单位统一为毫米(mm)，图像坐标以碑面左上角为原点，x 向右、y 向下

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 碑刻档案 */
export interface SteleRecord {
  id: string;
  name: string;
  dynasty: string; // 年代
  heightMm: number;
  widthMm: number;
  thicknessMm: number;
  location: string; // 所在位置
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 一次扫描 */
export interface ScanRecord {
  id: string;
  steleId: string;
  label: string;
  sourceName: string;
  format: 'ply' | 'obj' | 'generated';
  vertexCount: number;
  faceCount: number;
  widthMm: number;
  heightMm: number;
  /** 基准面拟合后的残差统计 */
  planeFitRmsMm: number;
  createdAt: number;
}

/** 拓片风格预设 */
export type RubbingPreset = 'wujin' | 'chanyi';

/** 拓片参数 */
export interface RubbingParams {
  preset: RubbingPreset;
  inkPouchMm: number; // 墨包半径（高斯尺度）
  contrast: number; // 墨色浓淡 0..1
  gamma: number; // 墨阶 gamma
  roughness: number; // 石花/泐痕保留强度 0..1
  paperGrain: number; // 纸张纹理强度 0..1
  edgeEnhance: number; // 刻口边缘增强 0..1
}

/** 补墨笔触（局部加深/减淡） */
export interface RetouchStroke {
  id: string;
  cxMm: number;
  cyMm: number;
  radiusMm: number;
  strength: number; // 正=加深吃墨，负=减淡留白
}

export interface BBoxMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 框选单字 */
export interface CharacterBox {
  id: string;
  index: number; // 编号
  bbox: BBoxMm;
  label: string;
}

/** 配准结果（老拓片照片 -> 数字拓片的 3x3 单应矩阵，列主序） */
export interface Registration {
  matrix: number[]; // length 9, column-major
  ncc: number; // 配准相似度
}

export interface AppSettings {
  defaultDpi: number;
  gpuTileSize: number;
  maxScreenPixels: number;
  inkDark: string;
  paperLight: string;
}

/** 三角网格（内存态，可能很大，不进结构化克隆的持久层） */
export interface TriangleMesh {
  positions: Float32Array; // xyz 交错
  normals: Float32Array | null;
  indices: Uint32Array;
  widthMm: number;
  heightMm: number;
}

/** 高度场（基准面校正后，z 单位 mm；空点为 NaN） */
export interface HeightField {
  data: Float32Array;
  widthPx: number;
  heightPx: number;
  pxPerMm: number;
  widthMm: number;
  heightMm: number;
}

export const DEFAULT_RUBBING_PARAMS: RubbingParams = {
  preset: 'wujin',
  inkPouchMm: 1.2,
  contrast: 0.82,
  gamma: 1.0,
  roughness: 0.6,
  paperGrain: 0.25,
  edgeEnhance: 0.7,
};

export const PRESET_PARAMS: Record<RubbingPreset, RubbingParams> = {
  // 乌金拓：墨色乌黑发亮、对比强烈
  wujin: { preset: 'wujin', inkPouchMm: 1.0, contrast: 0.95, gamma: 0.85, roughness: 0.45, paperGrain: 0.18, edgeEnhance: 0.85 },
  // 蝉翼拓：淡墨如蝉翼、层次柔和、石花清晰
  chanyi: { preset: 'chanyi', inkPouchMm: 1.8, contrast: 0.5, gamma: 1.35, roughness: 0.85, paperGrain: 0.4, edgeEnhance: 0.55 },
};

export const DEFAULT_SETTINGS: AppSettings = {
  defaultDpi: 600,
  gpuTileSize: 1024,
  maxScreenPixels: 2048 * 2048,
  inkDark: '#141210',
  paperLight: '#f2ede1',
};

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
