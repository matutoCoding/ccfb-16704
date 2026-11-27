// Worker 客户端封装：Promise 化消息、进度回调
import type { HeightField } from '../types';

export interface WorkerResult {
  heightField: HeightField;
  vertexCount: number;
  faceCount: number;
  planeRmsMm: number;
  widthMm: number;
  heightMm: number;
}

export function processInWorker(
  req: { kind: 'file'; name: string; buffer: ArrayBuffer; format: 'ply' | 'obj'; pxPerMm: number } | { kind: 'generated'; pxPerMm: number },
  onProgress: (stage: string, pct: number) => void,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./process.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        onProgress(msg.stage, msg.pct);
      } else if (msg.type === 'done') {
        worker.terminate();
        if (msg.ok) {
          resolve({
            heightField: msg.heightField as HeightField,
            vertexCount: msg.vertexCount,
            faceCount: msg.faceCount,
            planeRmsMm: msg.planeRmsMm,
            widthMm: msg.widthMm,
            heightMm: msg.heightMm,
          });
        } else reject(new Error(msg.error));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(req);
  });
}
