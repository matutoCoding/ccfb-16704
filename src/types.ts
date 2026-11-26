export type ID = string;

export type PageId =
  | 'archive'
  | 'scan'
  | 'rubbing'
  | 'compare'
  | 'export'
  | 'settings';

export interface Stele {
  id: ID;
  name: string;
  dynasty: string;
  era: string;
  yearNote: string;
  heightMm: number;
  widthMm: number;
  thicknessMm?: number;
  location: string;
  material: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface FitParams {
  centerX: number;
  centerY: number;
  scale: number;
  /** baseline = c0 + c1 u + c2 v + c3 u² + c4 uv + c5 v² */
  coeffs: [number, number, number, number, number, number];
  order: 1 | 2;
  rmsMm: number;
  maxAbsMm: number;
  corrected: boolean;
}

export interface GlyphTruth {
  id: string;
  index: number;
  char: string;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  maskSize: number;
  /** Alpha/coverage mask, maskSize × maskSize. */
  mask: Uint8Array;
  edgePoints?: Array<{ x: number; y: number }>;
}

export interface PitTruth {
  x: number;
  y: number;
  r: number;
  depth: number;
  kind: 'pit' | 'spall' | 'new-damage';
}

export interface GroundTruth {
  widthMm: number;
  heightMm: number;
  glyphs: GlyphTruth[];
  pits: PitTruth[];
  nominalEdgeToleranceMm: number;
  generatedAt: number;
}

export interface ScanRecord {
  id: ID;
  steleId: ID;
  name: string;
  source: 'procedural' | 'ply' | 'obj';
  fileName?: string;
  note?: string;
  createdAt: number;
  widthMm: number;
  heightMm: number;
  depthMinMm: number;
  depthMaxMm: number;
  vertexCount: number;
  faceCount: number;
  positions: Float32Array;
  indices: Uint32Array;
  grid?: { nx: number; ny: number };
  fit?: FitParams;
  groundTruth?: GroundTruth;
  seed?: number;
}

export interface RubbingParams {
  preset: 'wujin' | 'chanyi' | 'custom';
  inkDensity: number;
  contrast: number;
  cutThresholdMm: number;
  edgeSharpness: number;
  weathering: number;
  paperStrength: number;
  paperScale: number;
  padTexture: number;
  padScaleMm: number;
  inkWarmth: number;
  showPaper: boolean;
}

export interface BrushStroke {
  id: ID;
  mode: 'burn' | 'dodge';
  /** normalized physical coordinates, x/width and y/height, y up. */
  points: Array<{ x: number; y: number }>;
  radiusMm: number;
  strength: number;
  createdAt: number;
}

export interface CharacterBox {
  id: ID;
  index: number;
  label: string;
  /** physical mm, centered origin, y up. */
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

export interface RubbingDocument {
  id: ID;
  steleId: ID;
  scanId: ID;
  name: string;
  params: RubbingParams;
  strokes: BrushStroke[];
  boxes: CharacterBox[];
  updatedAt: number;
}

export interface CompareRecord {
  id: ID;
  steleId: ID;
  scanId: ID;
  rubbingId?: ID;
  oldPhotoName?: string;
  oldPhotoBlob?: Blob;
  transform?: RegistrationTransform;
  diffSummary?: DiffSummary;
  updatedAt: number;
}

export interface RegistrationTransform {
  scale: number;
  rotationDeg: number;
  tx: number;
  ty: number;
  score: number;
  width: number;
  height: number;
}

export interface DiffRegion {
  id: ID;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  severity: number;
  centroidX: number;
  centroidY: number;
  kind: 'new-loss' | 'old-loss' | 'shift';
}

export interface DiffSummary {
  score: number;
  newLossPixels: number;
  oldOnlyPixels: number;
  regions: DiffRegion[];
  alignedAt: number;
}

export interface Settings {
  id: 'app';
  defaultDpi: number;
  tilePx: number;
  autoSeed: boolean;
  renderScale: number;
  coordinateUnit?: 'mm';
  lastSteleId?: ID;
  lastScanId?: ID;
}

export interface ToastMessage {
  id: number;
  type: 'info' | 'success' | 'error' | 'warning';
  text: string;
}

export const DEFAULT_RUBBING_PARAMS: RubbingParams = {
  preset: 'wujin',
  inkDensity: 0.94,
  contrast: 1.35,
  cutThresholdMm: 0.022,
  edgeSharpness: 0.92,
  weathering: 0.82,
  paperStrength: 0.34,
  paperScale: 1.0,
  padTexture: 0.22,
  padScaleMm: 18,
  inkWarmth: 0.18,
  showPaper: true,
};

export const CHANYI_PARAMS: RubbingParams = {
  ...DEFAULT_RUBBING_PARAMS,
  preset: 'chanyi',
  inkDensity: 0.42,
  contrast: 1.05,
  cutThresholdMm: 0.018,
  edgeSharpness: 0.86,
  weathering: 0.95,
  paperStrength: 0.58,
  padTexture: 0.38,
  inkWarmth: 0.28,
};
