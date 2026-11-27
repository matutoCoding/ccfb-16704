// PLY 解析器：支持 ascii / binary_little_endian，常用 property（x,y,z,nx,ny,nz）
import type { TriangleMesh } from '../types';
import { finalizeMesh, GrowableF32, GrowableU32 } from './mesh';

interface PlyProp {
  name: string;
  type: string;
  isList: boolean;
  countType?: string;
}

const TYPE_SIZE: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

function readScalar(view: DataView, off: number, type: string, littleEndian: boolean): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(off);
    case 'uchar': case 'uint8': return view.getUint8(off);
    case 'short': case 'int16': return view.getInt16(off, littleEndian);
    case 'ushort': case 'uint16': return view.getUint16(off, littleEndian);
    case 'int': case 'int32': return view.getInt32(off, littleEndian);
    case 'uint': case 'uint32': return view.getUint32(off, littleEndian);
    case 'float': case 'float32': return view.getFloat32(off, littleEndian);
    case 'double': case 'float64': return view.getFloat64(off, littleEndian);
    default: throw new Error(`PLY: 不支持的标量类型 ${type}`);
  }
}

export function parsePly(buffer: ArrayBuffer): TriangleMesh {
  const bytes = new Uint8Array(buffer);
  // 解析头部（ASCII 行）
  let headerEnd = -1;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 10 && bytes[i - 1] === 13) {
      // CRLF
    }
    if (bytes[i] === 10 && i + 4 < bytes.length && bytes[i + 1] === 101 && bytes[i + 2] === 110 && bytes[i + 3] === 100) {
      // '\nend'
      headerEnd = i;
      break;
    }
  }
  if (headerEnd < 0) throw new Error('PLY: 找不到 end_header');
  const headerText = new TextDecoder('ascii').decode(bytes.subarray(0, headerEnd));
  const lines = headerText.split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new Error('PLY: 非法文件头');

  let format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' = 'ascii';
  const elements: { name: string; count: number; props: PlyProp[] }[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    const t = line.split(/\s+/);
    if (t[0] === 'format') format = t[1] as typeof format;
    else if (t[0] === 'element') elements.push({ name: t[1], count: Number(t[2]), props: [] });
    else if (t[0] === 'property') {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ name: t[4], type: t[3], isList: true, countType: t[2] });
      else el.props.push({ name: t[2], type: t[1], isList: false });
    }
  }
  // end_header 后是一个换行
  let dataOff = headerEnd + 1;
  if (bytes[dataOff] === 10) dataOff++;

  const pos = new GrowableF32();
  const idx = new GrowableU32();
  let normals: Float32Array | null = null;
  const hasNormal = elements.some((e) => e.name === 'vertex' && e.props.some((p) => p.name === 'nx'));

  if (format === 'ascii') {
    const text = new TextDecoder('ascii').decode(bytes.subarray(dataOff));
    const tokens = text.split(/\s+/);
    let cursor = 0;
    for (const el of elements) {
      if (el.name === 'vertex') {
        if (hasNormal) normals = new Float32Array(el.count * 3);
        for (let i = 0; i < el.count; i++) {
          const rec: Record<string, number> = {};
          for (const p of el.props) {
            if (p.isList) {
              const n = Number(tokens[cursor++]);
              cursor += n;
              rec[p.name] = n;
            } else rec[p.name] = Number(tokens[cursor++]);
          }
          pos.push(rec.x, rec.y, rec.z);
          if (hasNormal) {
            normals![i * 3] = rec.nx;
            normals![i * 3 + 1] = rec.ny ?? 0;
            normals![i * 3 + 2] = rec.nz ?? 0;
          }
        }
      } else if (el.name === 'face') {
        for (let i = 0; i < el.count; i++) {
          const rec: Record<string, number | number[]> = {};
          for (const p of el.props) {
            if (p.isList) {
              const n = Number(tokens[cursor++]);
              const list: number[] = [];
              for (let k = 0; k < n; k++) list.push(Number(tokens[cursor++]));
              rec[p.name] = list;
            } else rec[p.name] = Number(tokens[cursor++]);
          }
          const verts = (rec.vertex_indices ?? []) as number[];
          for (let k = 1; k < verts.length - 1; k++) idx.push(verts[0], verts[k], verts[k + 1]);
        }
      } else {
        // 跳过未知元素
        for (let i = 0; i < el.count; i++) for (const p of el.props) cursor += p.isList ? 1 + Number(tokens[cursor]) : 1;
      }
    }
  } else {
    const littleEndian = format === 'binary_little_endian';
    const view = new DataView(buffer);
    let off = dataOff;
    for (const el of elements) {
      if (el.name === 'vertex') {
        if (hasNormal) normals = new Float32Array(el.count * 3);
        const stride = el.props.reduce((s, p) => s + (p.isList ? 0 : TYPE_SIZE[p.type] ?? 1), 0);
        for (let i = 0; i < el.count; i++) {
          const base = off;
          let fieldOff = base;
          const rec: Record<string, number> = {};
          for (const p of el.props) {
            if (p.isList) throw new Error('PLY: vertex 不支持 list 属性');
            rec[p.name] = readScalar(view, fieldOff, p.type, littleEndian);
            fieldOff += TYPE_SIZE[p.type];
          }
          off = base + stride;
          pos.push(rec.x, rec.y, rec.z);
          if (hasNormal) {
            normals![i * 3] = rec.nx;
            normals![i * 3 + 1] = rec.ny ?? 0;
            normals![i * 3 + 2] = rec.nz ?? 0;
          }
        }
      } else if (el.name === 'face') {
        for (let i = 0; i < el.count; i++) {
          let verts: number[] = [];
          for (const p of el.props) {
            if (p.isList) {
              const n = readScalar(view, off, p.countType!, littleEndian);
              off += TYPE_SIZE[p.countType!];
              const list: number[] = [];
              for (let k = 0; k < n; k++) {
                list.push(readScalar(view, off, p.type, littleEndian));
                off += TYPE_SIZE[p.type];
              }
              if (p.name === 'vertex_indices') verts = list;
            } else off += TYPE_SIZE[p.type];
          }
          for (let k = 1; k < verts.length - 1; k++) idx.push(verts[0], verts[k], verts[k + 1]);
        }
      } else {
        for (let i = 0; i < el.count; i++) {
          for (const p of el.props) {
            if (p.isList) {
              const n = readScalar(view, off, p.countType!, littleEndian);
              off += TYPE_SIZE[p.countType!] + n * TYPE_SIZE[p.type];
            } else off += TYPE_SIZE[p.type];
          }
        }
      }
    }
  }
  return finalizeMesh(pos, idx, normals);
}
