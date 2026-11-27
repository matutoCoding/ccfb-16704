// 对比校勘页：数字拓片与老拓片照片叠合，自动配准 + 差异区域高亮
import { repo } from '../db/repo';
import { hideProgress, showProgress, store, toast } from '../state';
import { clear, h, slider } from '../ui/dom';
import { DEFAULT_RUBBING_PARAMS } from '../types';
import { getOrCreateSession } from '../gl/session';
import { toGrayscale, warpGray } from '../gl/image';
import { computeDiffMask, GrayImage, registerImages } from '../geometry/registration';

const WORK_SIDE = 1024; // 配准工作分辨率

export async function renderCollatePage(root: HTMLElement): Promise<void> {
  clear(root);
  const scan = store.currentScan();
  const sidebar = h('div', { class: 'sidebar' });
  const stage = h('div', { class: 'stage' });
  root.append(sidebar, stage);

  if (!scan) {
    stage.append(emptyPrompt('请先完成一次扫描并生成拓片'));
    return;
  }
  const hf = await repo.loadHeightField(scan.id);
  if (!hf) {
    stage.append(emptyPrompt('高度场缺失'));
    return;
  }
  const params = await repo.getParams(scan.id, DEFAULT_RUBBING_PARAMS);
  const strokes = await repo.getStrokes(scan.id);
  const settings = await repo.getSettings();

  // 数字拓片离屏渲染到工作分辨率
  const glCanvas = h('canvas') as HTMLCanvasElement;
  glCanvas.width = 2;
  glCanvas.height = 2;
  const session = getOrCreateSession(glCanvas, scan.id + ':collate');
  session.engine.setHeightField(hf);
  session.editor.setStrokes(strokes);

  const outW = Math.round((WORK_SIDE * Math.min(1, hf.widthMm / hf.heightMm)) );
  const outH = Math.round(outW * (hf.heightPx / hf.widthPx));
  const prog = showProgress('渲染数字拓片…', 0.1);
  const rubbingImg = await session.engine.renderFull(outW, outH, {
    params, strokes, inkColor: settings.inkDark, paperColor: settings.paperLight,
    tileSize: 1024, onProgress: (p) => showProgress('渲染数字拓片…', 0.1 + p * 0.3),
  });
  hideProgress();
  const refGray: GrayImage = { data: toGrayscale(rubbingImg), width: outW, height: outH };

  let photoImg: HTMLImageElement | null = null;
  let photoGray: GrayImage | null = null;
  let diffMask: Float32Array | null = null;
  let regH: number[] | null = (await repo.getRegistration(scan.id))?.matrix ?? null;
  let blend = 0.55;
  let showDiff = 1;

  const view = h('canvas', { width: outW, height: outH }) as HTMLCanvasElement;
  const wrap = h('div', {
    style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:20px',
  }, view);
  stage.append(wrap);

  function drawView(): void {
    const ctx = view.getContext('2d')!;
    ctx.fillStyle = '#f2ede1';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(rubbingCanvas(rubbingImg), 0, 0, outW, outH);
    if (photoImg && regH) {
      const warped = warpGray(photoGray!.data, photoGray!.width, photoGray!.height, outW, outH, regH);
      const img = grayToImage(warped, outW, outH);
      ctx.globalAlpha = 1 - blend;
      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = 1;
      if (diffMask && showDiff > 0) {
        const overlay = diffToImage(diffMask, outW, outH, showDiff);
        ctx.drawImage(overlay, 0, 0);
      }
    }
  }

  // 老照片选择
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', style: 'display:none',
    onchange: async () => {
      const f = fileInput.files?.[0];
      if (f) await loadPhoto(f);
      fileInput.value = '';
    },
  }) as HTMLInputElement;

  const saved = await repo.loadOldPhoto(scan.id);
  const card = h('div', { class: 'card' }, h('h3', { textContent: '老拓片照片' }));
  card.append(
    h('div', { class: 'muted', textContent: '支持 JPG/PNG，自动估计平移、旋转与缩放配准。' }),
    h('div', { class: 'btn-row', style: 'margin-top:8px' },
      h('button', { class: 'btn', textContent: saved ? '替换照片' : '选择照片', onclick: () => fileInput.click() }),
      h('button', {
        class: 'btn ghost', textContent: '自动配准', onclick: () => runRegister(),
      }),
    ),
    fileInput,
  );
  sidebar.append(card);

  const viewCard = h('div', { class: 'card' }, h('h3', { textContent: '叠合显示' }));
  viewCard.append(
    slider('数字拓片占比', 0, 1, 0.01, blend, (v) => { blend = v; drawView(); }),
    slider('差异高亮', 0, 1, 0.01, showDiff, (v) => { showDiff = v; drawView(); }),
  );
  const nccLine = h('div', { class: 'metric' }, h('span', { textContent: '配准相似度 NCC' }), h('b', { textContent: regH ? '已配准' : '—' }));
  viewCard.append(nccLine);
  sidebar.append(viewCard);

  async function loadPhoto(f: File): Promise<void> {
    await repo.saveOldPhoto(scan!.id, f);
    const url = URL.createObjectURL(f);
    photoImg = await loadImage(url);
    URL.revokeObjectURL(url);
    const c = new OffscreenCanvas(photoImg.naturalWidth, photoImg.naturalHeight);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(photoImg, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    photoGray = { data: toGrayscale(data), width: c.width, height: c.height };
    regH = null;
    diffMask = null;
    toast('照片已载入，点击「自动配准」');
  }

  async function runRegister(): Promise<void> {
    if (!photoGray) return toast('请先选择老拓片照片');
    const scanId = scan!.id;
    const p = showProgress('自动配准中（粗搜 + 精修）…', 0.05);
    await new Promise((r) => setTimeout(r, 30));
    try {
      const result = registerImages(refGray, photoGray, (pct) => showProgress('自动配准中（粗搜 + 精修）…', pct));
      regH = result.H;
      await repo.saveRegistration(scanId, { matrix: result.H, ncc: result.ncc });
      showProgress('计算差异区域…', 0.9);
      await new Promise((r) => setTimeout(r, 30));
      diffMask = computeDiffMask(refGray, photoGray, result.H);
      nccLine.querySelector('b')!.textContent = result.ncc.toFixed(4);
      nccLine.querySelector('b')!.className = result.ncc > 0.5 ? '' : 'bad';
      hideProgress();
      toast(`配准完成 NCC=${result.ncc.toFixed(3)}，红色为差异（可能的后期泐损）`);
      drawView();
    } catch (e) {
      hideProgress();
      toast('配准失败：' + (e as Error).message);
    }
  }

  if (saved) {
    const url = URL.createObjectURL(saved);
    photoImg = await loadImage(url);
    URL.revokeObjectURL(url);
    const c = new OffscreenCanvas(photoImg.naturalWidth, photoImg.naturalHeight);
    c.getContext('2d')!.drawImage(photoImg, 0, 0);
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    photoGray = { data: toGrayscale(data), width: c.width, height: c.height };
    if (regH) {
      diffMask = computeDiffMask(refGray, photoGray, regH);
      const reg = await repo.getRegistration(scan.id);
      nccLine.querySelector('b')!.textContent = reg?.ncc.toFixed(4) ?? '已配准';
    }
  }

  stage.append(h('div', { class: 'overlay-toolbar' },
    h('button', { textContent: '← 拓片生成', onclick: () => store.update({ route: 'rubbing' }) }),
    h('button', { textContent: '单字框选 →', onclick: () => store.update({ route: 'export' }) }),
  ));
  drawView();
}

function emptyPrompt(text: string): HTMLElement {
  return h('div', { class: 'empty' }, h('div', { style: 'font-size:40px' }, '🔍'), h('div', { textContent: text }));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function rubbingCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

function grayToImage(gray: Float32Array, W: number, H: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < gray.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i])));
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function diffToImage(mask: Float32Array, W: number, H: number, strength: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < mask.length; i++) {
    const a = Math.min(1, mask[i] * strength);
    img.data[i * 4] = 230;
    img.data[i * 4 + 1] = 70;
    img.data[i * 4 + 2] = 40;
    img.data[i * 4 + 3] = Math.round(a * 200);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
