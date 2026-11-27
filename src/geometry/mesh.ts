import type { TriangleMesh } from '../types';

/** 可扩容 TypedArray，避免几百万顶点时 number[] 的装箱开销 */
export class GrowableF32 {
  arr: Float32Array;
  size = 0;
  constructor(cap = 4096) {
    this.arr = new Float32Array(new ArrayBuffer(cap * 4));
  }
  push(...values: number[]): void {
    for (const x of values) {
      if (this.size === this.arr.length) {
        const next = new Float32Array(this.arr.length * 2);
        next.set(this.arr);
        this.arr = next;
      }
      this.arr[this.size++] = x;
    }
  }
  view(): Float32Array {
    return this.arr.subarray(0, this.size);
  }
}

export class GrowableU32 {
  arr: Uint32Array;
  size = 0;
  constructor(cap = 4096) {
    this.arr = new Uint32Array(new ArrayBuffer(cap * 4));
  }
  push(...values: number[]): void {
    for (const x of values) {
      if (this.size === this.arr.length) {
        const next = new Uint32Array(this.arr.length * 2);
        next.set(this.arr);
        this.arr = next;
      }
      this.arr[this.size++] = x;
    }
  }
  view(): Uint32Array {
    return this.arr.subarray(0, this.size);
  }
}

export function finalizeMesh(
  pos: GrowableF32,
  idx: GrowableU32,
  normals: Float32Array | null,
): TriangleMesh {
  const positions = Float32Array.from(pos.view());
  const indices = Uint32Array.from(idx.view());
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    positions,
    normals,
    indices,
    widthMm: maxX - minX,
    heightMm: maxY - minY,
  };
}
