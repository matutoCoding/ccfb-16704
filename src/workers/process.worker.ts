// 扫描处理 Web Worker：网格解析、基准面拟合、光栅化全部在后台线程
import { parsePly } from '../geometry/ply';
import { parseObj } from '../geometry/obj';
import { fitPlane, toLocal } from '../geometry/planeFit';
import { rasterizeHeightField } from '../geometry/heightfield';
import type { HeightField, TriangleMesh } from '../types';
import { generateSteleMesh } from '../geometry/stele-gen-core.js';

export type ProcessRequest =
  | { kind: 'file'; name: string; buffer: ArrayBuffer; format: 'ply' | 'obj'; pxPerMm: number }
  | { kind: 'generated'; pxPerMm: number };

export interface ProcessResponse {
  ok: boolean;
  error?: string;
  heightField?: HeightField;
  vertexCount?: number;
  faceCount?: number;
  planeRmsMm?: number;
  widthMm?: number;
  heightMm?: number;
}

function postProgress(stage: string, pct: number): void {
  postMessage({ type: 'progress', stage, pct });
}

function run(mesh: TriangleMesh, pxPerMm: number): ProcessResponse {
  postProgress('拟合基准面…', 0.08);
  const sampleStep = Math.max(1, Math.floor(mesh.positions.length / 3 / 500000));
  const fit = fitPlane(mesh.positions, sampleStep);
  postProgress('变换到基准面坐标系…', 0.18);
  const local = toLocal(mesh, fit);
  postProgress('光栅化高度场（去弯曲/补洞）…', 0.28);
  const heightField = rasterizeHeightField(local, mesh.indices, {
    pxPerMm,
    onProgress: (p) => postProgress('光栅化高度场（去弯曲/补洞）…', 0.28 + p * 0.68),
  });
  return {
    ok: true,
    heightField,
    vertexCount: mesh.positions.length / 3,
    faceCount: mesh.indices.length / 3,
    planeRmsMm: fit.rmsMm,
    widthMm: heightField.widthMm,
    heightMm: heightField.heightMm,
  };
}

self.onmessage = (ev: MessageEvent<ProcessRequest>) => {
  try {
    const req = ev.data;
    let mesh: TriangleMesh;
    if (req.kind === 'file') {
      postProgress(`解析 ${req.format.toUpperCase()}…`, 0.02);
      mesh = req.format === 'ply' ? parsePly(req.buffer) : parseObj(new TextDecoder().decode(req.buffer));
    } else {
      postProgress('生成程序测试碑面…', 0.02);
      const gen = generateSteleMesh();
      mesh = {
        positions: gen.positions,
        normals: null,
        indices: gen.indices,
        widthMm: gen.opts.widthMm,
        heightMm: gen.opts.heightMm,
      };
    }
    const resp = run(mesh, req.pxPerMm);
    postMessage({ type: 'done', ...resp } as ProcessResponse & { type: string });
  } catch (e) {
    postMessage({ type: 'done', ok: false, error: (e as Error).message } as ProcessResponse & { type: string });
  }
};
