import { jacobiEigen3, normalize, Vec3 } from './math';
import type { TriangleMesh } from '../types';

export interface PlaneFit {
  centroid: Vec3;
  normal: Vec3; // 指向扫描器一侧（凹槽点的有向距离为负）
  u: Vec3; // 面内 x 轴
  v: Vec3; // 面内 y 轴
  rmsMm: number;
}

/**
 * PCA 拟合基准面：协方差最小特征向量即法向。
 * 同时处理整体弯曲——返回二次弯曲场（在 heightfield 阶段做二次曲面去趋势）。
 */
export function fitPlane(positions: Float32Array, sampleStep = 1): PlaneFit {
  const n = positions.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let count = 0;
  for (let i = 0; i < n; i += sampleStep) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
    count++;
  }
  cx /= count;
  cy /= count;
  cz /= count;

  let sxx = 0;
  let sxy = 0;
  let sxz = 0;
  let syy = 0;
  let syz = 0;
  let szz = 0;
  for (let i = 0; i < n; i += sampleStep) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    sxx += dx * dx;
    sxy += dx * dy;
    sxz += dx * dz;
    syy += dy * dy;
    syz += dy * dz;
    szz += dz * dz;
  }
  const { vectors } = jacobiEigen3([sxx, sxy, sxz, syy, syz, szz]);
  let normal = vectors[0]; // 最小特征值对应向量

  // 面内坐标轴：u 取世界 x 在平面上的投影，保证方向稳定
  const worldX: Vec3 = [1, 0, 0];
  let u: Vec3 = [
    worldX[0] - normal[0] * (worldX[0] * normal[0] + worldX[1] * normal[1] + worldX[2] * normal[2]),
    worldX[1] - normal[1] * (worldX[0] * normal[0] + worldX[1] * normal[1] + worldX[2] * normal[2]),
    worldX[2] - normal[2] * (worldX[0] * normal[0] + worldX[1] * normal[1] + worldX[2] * normal[2]),
  ];
  if (Math.hypot(u[0], u[1], u[2]) < 1e-6) {
    const worldY: Vec3 = [0, 1, 0];
    u = [
      worldY[0] - normal[0] * (worldY[0] * normal[0] + worldY[1] * normal[1]),
      worldY[1] - normal[1] * (worldY[0] * normal[0] + worldY[1] * normal[1]),
      worldY[2] - normal[2] * (worldY[0] * normal[0] + worldY[1] * normal[1]),
    ];
  }
  u = normalize(u);
  const v = normalize([
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ]);

  // 法向定向：有向距离的偏度为负（凹槽多）时翻转，使凸起为正、凹陷为负
  let neg = 0;
  let pos = 0;
  for (let i = 0; i < n; i += sampleStep) {
    const d =
      (positions[i * 3] - cx) * normal[0] +
      (positions[i * 3 + 1] - cy) * normal[1] +
      (positions[i * 3 + 2] - cz) * normal[2];
    if (d < 0) neg++;
    else pos++;
  }
  if (neg > pos) {
    normal = [-normal[0], -normal[1], -normal[2]];
  }

  let ss = 0;
  for (let i = 0; i < n; i += sampleStep) {
    const d =
      (positions[i * 3] - cx) * normal[0] +
      (positions[i * 3 + 1] - cy) * normal[1] +
      (positions[i * 3 + 2] - cz) * normal[2];
    ss += d * d;
  }
  return {
    centroid: [cx, cy, cz],
    normal,
    u,
    v,
    rmsMm: Math.sqrt(ss / count),
  };
}

/** 点变换到基准面局部坐标 (u, v, w)，w 为有向高度（凸起正、凹陷负） */
export function toLocal(mesh: TriangleMesh, fit: PlaneFit): Float32Array {
  const { positions } = mesh;
  const out = new Float32Array(positions.length);
  const [nx, ny, nz] = fit.normal;
  const [ux, uy, uz] = fit.u;
  const [vx, vy, vz] = fit.v;
  const [cx, cy, cz] = fit.centroid;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    out[i] = dx * ux + dy * uy + dz * uz;
    out[i + 1] = dx * vx + dy * vy + dz * vz;
    out[i + 2] = dx * nx + dy * ny + dz * nz;
  }
  return out;
}
