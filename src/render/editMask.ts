import type { RubbingDocument, ScanRecord } from '../types';

export function createEditMask(scan: Pick<ScanRecord, 'widthMm' | 'heightMm'>, doc: RubbingDocument): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.max(2, Math.round((canvas.width * scan.heightMm) / scan.widthMm));
  const ctx = canvas.getContext('2d')!;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of doc.strokes) {
    ctx.save();
    ctx.globalAlpha = stroke.strength;
    ctx.strokeStyle = stroke.mode === 'burn' ? '#ff0000' : '#00ff00';
    ctx.lineWidth = Math.max(2, (stroke.radiusMm / scan.widthMm) * canvas.width * 2);
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const x = p.x * canvas.width;
      const y = (1 - p.y) * canvas.height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      ctx.arc(p.x * canvas.width, (1 - p.y) * canvas.height, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    } else {
      ctx.stroke();
    }
    ctx.restore();
  }
  return canvas;
}
