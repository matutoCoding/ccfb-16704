// OBJ 解析器：支持 v / vn / f（三角扇化多边形），忽略材质与曲线
import type { TriangleMesh } from '../types';
import { finalizeMesh, GrowableF32, GrowableU32 } from './mesh';

export function parseObj(text: string): TriangleMesh {
  const pos = new GrowableF32();
  const idx = new GrowableU32();
  const nrmList: number[] = [];
  let hasNormal = false;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('v ')) {
      const t = line.slice(2).trim().split(/\s+/);
      pos.push(Number(t[0]), Number(t[1]), Number(t[2] ?? 0));
    } else if (line.startsWith('vn ')) {
      const t = line.slice(3).trim().split(/\s+/);
      nrmList.push(Number(t[0]), Number(t[1]), Number(t[2]));
      hasNormal = true;
    } else if (line.startsWith('f ')) {
      const t = line.slice(2).trim().split(/\s+/);
      const face = t.map((tok) => {
        const vi = Number(tok.split('/')[0]);
        return vi > 0 ? vi - 1 : pos.size / 3 + vi; // 负索引
      });
      for (let k = 1; k < face.length - 1; k++) idx.push(face[0], face[k], face[k + 1]);
    }
  }
  const normals = hasNormal ? new Float32Array(pos.size) : null;
  if (hasNormal) {
    // 将按顶点索引的法向展开（OBJ 允许多个法向引用同一顶点，这里取顶点自身最近一次）
    for (let i = 0; i < pos.size / 3; i++) {
      normals![i * 3] = nrmList[i * 3] ?? 0;
      normals![i * 3 + 1] = nrmList[i * 3 + 1] ?? 1;
      normals![i * 3 + 2] = nrmList[i * 3 + 2] ?? 0;
    }
  }
  return finalizeMesh(pos, idx, normals);
}
