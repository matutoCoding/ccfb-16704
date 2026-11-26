import { FloatArrayBuilder, Uint32ArrayBuilder, computeBounds, orientFaceToXY } from './mesh';

export interface ParsedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  format: 'ply' | 'obj';
  sourceFaceCount: number;
}

type PlyProperty =
  | { kind: 'scalar'; name: string; type: string }
  | { kind: 'list'; name: string; countType: string; itemType: string };

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

const TYPE_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

export function parseMeshFile(fileName: string, buffer: ArrayBuffer): ParsedMesh {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ply')) return parsePLY(buffer);
  if (lower.endsWith('.obj')) return parseOBJ(new TextDecoder('utf-8').decode(buffer));
  throw new Error('仅支持 .ply 或 .obj 网格文件');
}

export function parsePLY(buffer: ArrayBuffer): ParsedMesh {
  const bytes = new Uint8Array(buffer);
  const headerEnd = findHeaderEnd(bytes);
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, headerEnd.headerEndOffset));
  const lines = header.split(/\r?\n/).filter(Boolean);
  if (lines[0]?.trim() !== 'ply') throw new Error('不是合法 PLY 文件');

  let format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' = 'ascii';
  const elements: PlyElement[] = [];
  let current: PlyElement | null = null;
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1] as typeof format;
    } else if (parts[0] === 'element') {
      current = { name: parts[1], count: Number(parts[2]), properties: [] };
      elements.push(current);
    } else if (parts[0] === 'property' && current) {
      if (parts[1] === 'list') {
        current.properties.push({ kind: 'list', name: parts[4], countType: parts[2], itemType: parts[3] });
      } else {
        current.properties.push({ kind: 'scalar', name: parts[2], type: parts[1] });
      }
    }
  }

  const vertexElement = elements.find((e) => e.name === 'vertex');
  const faceElement = elements.find((e) => e.name === 'face');
  if (!vertexElement) throw new Error('PLY 缺少 vertex 元素');

  const positions = new FloatArrayBuilder(vertexElement.count * 3);
  const indices = new Uint32ArrayBuilder();
  let sourceFaceCount = 0;

  if (format === 'ascii') {
    const body = new TextDecoder('utf-8').decode(bytes.subarray(headerEnd.bodyOffset));
    const allLines = body.split(/\r?\n/).filter((l) => l.trim().length);
    let lineIndex = 0;
    for (const element of elements) {
      for (let i = 0; i < element.count; i++) {
        const tokens = allLines[lineIndex++]?.trim().split(/\s+/) ?? [];
        if (element.name === 'vertex') {
          const x = Number(tokens[findScalarIndex(element, 'x')]);
          const y = Number(tokens[findScalarIndex(element, 'y')]);
          const z = Number(tokens[findScalarIndex(element, 'z')]);
          positions.push(x, y, z);
        } else if (element.name === 'face') {
          const listIndex = element.properties.findIndex((p) => p.kind === 'list');
          const offset = scalarTokenOffset(element, listIndex);
          const count = Number(tokens[offset]);
          const verts: number[] = [];
          for (let k = 0; k < count; k++) verts.push(Number(tokens[offset + 1 + k]));
          appendFace(verts, indices);
          sourceFaceCount++;
        }
      }
    }
  } else {
    const littleEndian = format === 'binary_little_endian';
    const view = new DataView(buffer, headerEnd.bodyOffset);
    let offset = 0;
    for (const element of elements) {
      for (let i = 0; i < element.count; i++) {
        if (element.name === 'vertex') {
          const values: Record<string, number> = {};
          for (const prop of element.properties) {
            if (prop.kind === 'scalar') {
              const size = TYPE_SIZES[prop.type] ?? 4;
              values[prop.name] = readScalar(view, offset, prop.type, littleEndian);
              offset += size;
            } else {
              const countSize = TYPE_SIZES[prop.countType] ?? 1;
              const count = readScalar(view, offset, prop.countType, littleEndian);
              offset += countSize;
              const itemSize = TYPE_SIZES[prop.itemType] ?? 4;
              offset += count * itemSize;
            }
          }
          positions.push(values.x ?? 0, values.y ?? 0, values.z ?? 0);
        } else if (element.name === 'face') {
          const verts: number[] = [];
          for (const prop of element.properties) {
            if (prop.kind === 'scalar') {
              offset += TYPE_SIZES[prop.type] ?? 4;
            } else {
              const countSize = TYPE_SIZES[prop.countType] ?? 1;
              const count = readScalar(view, offset, prop.countType, littleEndian);
              offset += countSize;
              const itemSize = TYPE_SIZES[prop.itemType] ?? 4;
              for (let k = 0; k < count; k++) {
                verts.push(readScalar(view, offset, prop.itemType, littleEndian));
                offset += itemSize;
              }
            }
          }
          appendFace(verts, indices);
          sourceFaceCount++;
        } else {
          offset += elementByteSize(element, view, offset, littleEndian);
        }
      }
    }
  }

  return { positions: positions.build(), indices: indices.build(), format: 'ply', sourceFaceCount };
}

function findHeaderEnd(bytes: Uint8Array): { headerEndOffset: number; bodyOffset: number } {
  const marker = new TextEncoder().encode('end_header');
  outer: for (let i = 0; i < bytes.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) continue outer;
    }
    let p = i + marker.length;
    if (bytes[p] === 13) p++;
    if (bytes[p] === 10) p++;
    return { headerEndOffset: i, bodyOffset: p };
  }
  throw new Error('PLY 缺少 end_header');
}

function findScalarIndex(element: PlyElement, name: string): number {
  let token = 0;
  for (const p of element.properties) {
    if (p.kind === 'scalar') {
      if (p.name === name) return token;
      token++;
    } else {
      token += 1 + 1; // ASCII list count and values are read dynamically; only used for x/y/z before list.
    }
  }
  return 0;
}

function scalarTokenOffset(element: PlyElement, propertyIndex: number): number {
  let token = 0;
  for (let i = 0; i < propertyIndex; i++) {
    const p = element.properties[i];
    if (p.kind === 'scalar') token++;
    // Lists before the face index are unusual; ASCII dynamic parsing does not need their values here.
  }
  return token;
}

function readScalar(view: DataView, offset: number, type: string, littleEndian: boolean): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, littleEndian);
    case 'ushort': case 'uint16': return view.getUint16(offset, littleEndian);
    case 'int': case 'int32': return view.getInt32(offset, littleEndian);
    case 'uint': case 'uint32': return view.getUint32(offset, littleEndian);
    case 'float': case 'float32': return view.getFloat32(offset, littleEndian);
    case 'double': case 'float64': return view.getFloat64(offset, littleEndian);
    default: return view.getFloat32(offset, littleEndian);
  }
}

function elementByteSize(element: PlyElement, view: DataView, offset: number, littleEndian: boolean): number {
  let size = 0;
  for (const p of element.properties) {
    if (p.kind === 'scalar') size += TYPE_SIZES[p.type] ?? 4;
    else {
      const count = readScalar(view, offset + size, p.countType, littleEndian);
      size += TYPE_SIZES[p.countType] ?? 1;
      size += count * (TYPE_SIZES[p.itemType] ?? 4);
    }
  }
  return size;
}

export function parseOBJ(text: string): ParsedMesh {
  const positions = new FloatArrayBuilder();
  const uv: number[] = [];
  const normals: number[] = [];
  const indices = new Uint32ArrayBuilder();
  let sourceFaceCount = 0;
  let vertexBase = 0;

  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === 'vt') {
      uv.push(Number(parts[1]), Number(parts[2]));
    } else if (parts[0] === 'vn') {
      normals.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === 'f') {
      const verts: number[] = [];
      for (let i = 1; i < parts.length; i++) {
        const token = parts[i];
        const vi = Number(token.split('/')[0]);
        verts.push(vi < 0 ? positions.length / 3 + vi : vi - 1 - vertexBase);
      }
      appendFace(verts, indices);
      sourceFaceCount++;
    }
  }
  void uv; void normals;
  return { positions: positions.build(), indices: indices.build(), format: 'obj', sourceFaceCount };
}

function appendFace(verts: number[], indices: Uint32ArrayBuilder): void {
  if (verts.length < 3) return;
  for (let i = 1; i < verts.length - 1; i++) {
    indices.push(verts[0], verts[i], verts[i + 1]);
  }
}

export function prepareImportedMesh(parsed: ParsedMesh, unit: 'auto' | 'mm' | 'cm' | 'm' = 'auto', orient = true): ParsedMesh & { unitScale: number } {
  let positions = parsed.positions;
  const bounds = computeBounds(positions);
  const maxSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  let unitScale = 1;
  if (unit === 'm') unitScale = 1000;
  else if (unit === 'cm') unitScale = 10;
  else if (unit === 'auto') unitScale = maxSpan > 0 && maxSpan <= 4 ? 1000 : maxSpan < 80 ? 10 : 1;
  if (unitScale !== 1) {
    positions = new Float32Array(positions.length);
    for (let i = 0; i < parsed.positions.length; i++) positions[i] = parsed.positions[i] * unitScale;
  }
  if (orient) {
    positions = orientFaceToXY(positions).positions;
  }
  return { ...parsed, positions, unitScale };
}
