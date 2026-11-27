// 程序化碑面生成核心的类型声明（实现为纯 ESM JavaScript）
export interface SteleGenOptions {
  widthMm: number;
  heightMm: number;
  nx: number;
  ny: number;
  grooveDepthMm: number;
  seed: number;
  [k: string]: unknown;
}

export interface GenCharacter {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  index: number;
}

export interface Pit {
  cx: number;
  cy: number;
  radius: number;
  depth: number;
}

export interface GeneratedStele {
  positions: Float32Array;
  indices: Uint32Array;
  chars: GenCharacter[];
  pits: Pit[];
  opts: Required<SteleGenOptions>;
}

export interface GroundTruth {
  mask: Uint8Array;
  owner: Int16Array;
  widthPx: number;
  heightPx: number;
  pxPerMm: number;
}

export function defaultSteleOptions(): SteleGenOptions;
export function layoutCharacters(widthMm: number, heightMm: number): GenCharacter[];
export function makePits(opts: SteleGenOptions): Pit[];
export function grooveDepthAt(
  xMm: number,
  yMm: number,
  opts: SteleGenOptions,
  chars: GenCharacter[],
): { depth: number; charIndex: number };
export function generateSteleMesh(opts?: Partial<SteleGenOptions>): GeneratedStele;
export function generateGroundTruth(
  widthMm: number,
  heightMm: number,
  pxPerMm: number,
  opts: SteleGenOptions,
  chars: GenCharacter[],
): GroundTruth;
