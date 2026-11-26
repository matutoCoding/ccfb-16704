import { RubbingEngine, fullRect } from '../render/RubbingEngine';
import { DEFAULT_RUBBING_PARAMS, type RubbingParams, type ScanRecord } from '../types';

/** Creates an aged, slightly rotated “old rubbing photograph” for offline testing. */
export async function createOldPhotoBlob(
  scan: ScanRecord,
  params: RubbingParams = DEFAULT_RUBBING_PARAMS,
): Promise<Blob> {
  const sourceW = 900;
  const sourceH = Math.round(sourceW * scan.heightMm / scan.widthMm);
  const engine = new RubbingEngine();
  let rubbing: HTMLCanvasElement;
  try {
    engine.setScan(scan);
    const image = engine.renderImageData(fullRect(scan), sourceW, sourceH, { ...params, preset: 'wujin' });
    rubbing = document.createElement('canvas');
    rubbing.width = sourceW;
    rubbing.height = sourceH;
    rubbing.getContext('2d')!.putImageData(image, 0, 0);
  } finally {
    engine.dispose();
  }

  const photo = document.createElement('canvas');
  photo.width = sourceW;
  photo.height = sourceH;
  const ctx = photo.getContext('2d')!;
  ctx.fillStyle = '#c8b17f';
  ctx.fillRect(0, 0, photo.width, photo.height);

  // Paper/photo grain.
  const grain = ctx.createImageData(photo.width, photo.height);
  let seed = 1234567;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < grain.data.length; i += 4) {
    const n = (rand() - 0.5) * 34;
    grain.data[i] = 198 + n;
    grain.data[i + 1] = 176 + n * 0.8;
    grain.data[i + 2] = 126 + n * 0.5;
    grain.data[i + 3] = 255;
  }
  ctx.putImageData(grain, 0, 0);

  ctx.save();
  ctx.translate(photo.width / 2, photo.height / 2);
  ctx.rotate((-2.6 * Math.PI) / 180);
  ctx.scale(0.955, 0.955);
  ctx.filter = 'sepia(0.28) contrast(1.08) brightness(0.96) blur(0.35px)';
  ctx.drawImage(rubbing, -sourceW / 2, -sourceH / 2);
  ctx.restore();
  ctx.filter = 'none';

  const gradient = ctx.createRadialGradient(sourceW / 2, sourceH / 2, sourceH * 0.25, sourceW / 2, sourceH / 2, sourceH * 0.72);
  gradient.addColorStop(0, 'rgba(80,50,20,0)');
  gradient.addColorStop(1, 'rgba(70,42,16,.34)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, sourceW, sourceH);

  // Scratches and foxing.
  for (let i = 0; i < 90; i++) {
    ctx.strokeStyle = `rgba(70,42,18,${0.03 + rand() * 0.08})`;
    ctx.lineWidth = 0.5 + rand() * 1.4;
    ctx.beginPath();
    const x = rand() * sourceW;
    const y = rand() * sourceH;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 80, y + 30 + rand() * 180);
    ctx.stroke();
  }

  return await new Promise<Blob>((resolve, reject) => {
    photo.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('老拓片示例生成失败'))), 'image/jpeg', 0.92);
  });
}
