import { db, uid } from '../db';
import { loadState, state } from '../state';
import { h, mount, toast, downloadBlob } from '../ui/dom';
import { RubbingEngine, fullRect } from '../render/RubbingEngine';
import {
  computeDiff,
  imageDataToGray,
  makeCanvasFromImage,
  registerGray,
  drawAlignedImage,
  warpGray,
  type GrayImage,
} from '../compare/registration';
import { createOldPhotoBlob } from '../compare/samplePhoto';
import { ensureRubbingDocument } from '../state';
import type { CompareRecord, DiffSummary, RegistrationTransform } from '../types';
import type { PageRenderer } from './types';

interface DiffResult extends DiffSummary {
  width: number;
  height: number;
  newMask: Uint8Array;
  oldOnlyMask: Uint8Array;
}

export const renderCompare: PageRenderer = async (view, ctx) => {
  await loadState();
  const scan = state.scans.find((s) => s.id === state.currentScanId) ?? state.scans[0];
  if (!scan) {
    view.append(h('div', { class: 'card' }, h('div', { class: 'empty-state' }, h('h3', {}, '没有可校勘的扫描'), h('button', { class: 'btn primary', onclick: () => ctx.navigate('archive') }, '前往档案'))));
    return;
  }

  const doc = await ensureRubbingDocument(scan);
  const targetW = 640;
  const targetH = Math.round(targetW * scan.heightMm / scan.widthMm);
  let oldCanvas: HTMLCanvasElement | null = null;
  let oldGray: GrayImage | null = null;
  let transform: RegistrationTransform | null = null;
  let diff: DiffResult | null = null;
  let objectUrl: string | null = null;
  let compareRecord: CompareRecord = {
    id: uid('cmp'), steleId: scan.steleId, scanId: scan.id, rubbingId: doc.id, updatedAt: Date.now(),
  };

  const digitalCanvas = h('canvas', { width: targetW, height: targetH }) as HTMLCanvasElement;
  digitalCanvas.style.width = '100%';
  const oldLayer = h('canvas', { class: 'compare-overlay', width: targetW, height: targetH }) as HTMLCanvasElement;
  const diffLayer = h('canvas', { class: 'compare-overlay', width: targetW, height: targetH }) as HTMLCanvasElement;
  const regionLayer = h('div', { class: 'compare-overlay' });
  const wrap = h('div', { class: 'compare-wrap' }, digitalCanvas, oldLayer, diffLayer, regionLayer);
  const stage = h('div', { class: 'compare-stage' }, wrap);
  const panel = h('div', { class: 'card scroll' });
  view.append(h('div', { class: 'layout-work wide-panel' }, panel, stage));

  async function renderDigital(): Promise<GrayImage> {
    const engine = new RubbingEngine();
    try {
      engine.setScan(scan);
      const image = engine.renderImageData(fullRect(scan), targetW, targetH, doc.params);
      digitalCanvas.getContext('2d')!.putImageData(image, 0, 0);
      return imageDataToGray(image);
    } finally {
      engine.dispose();
    }
  }

  let digitalGray = await renderDigital();

  function renderPanel(busy = false, status = ''): void {
    const opacity = opacityInput ? Number(opacityInput.value) / 100 : 0.52;
    mount(panel,
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, '对比校勘'), h('p', {}, '相似度配准 · 容差差异 · 新泐区域高亮'))),
      h('div', { class: 'card-body grid', style: 'gap:13px' },
        h('label', { class: 'field' }, '数字拓片扫描',
          h('select', {
            onchange: async (e: Event) => {
              const id = (e.target as HTMLSelectElement).value;
              const next = state.scans.find((s) => s.id === id);
              if (!next) return;
              const { selectScan } = await import('../state');
              await selectScan(id);
              location.hash = '/compare';
            },
          }, ...state.scans.filter((s) => s.steleId === scan.steleId).map((s) => h('option', { value: s.id, selected: s.id === scan.id }, s.name))),
        ),
        h('div', { class: 'button-row' },
          h('label', { class: 'btn primary' }, '上传老拓片照片', h('input', { type: 'file', accept: 'image/*', style: 'display:none' }) as HTMLInputElement),
          h('button', { class: 'btn jade', id: 'sample-old' }, '生成示例老拓片'),
        ),
        status ? h('div', { class: 'code-block', style: 'padding:9px 11px' }, status) : h('p', { class: 'hint' }, '支持 JPG / PNG。配准在浏览器本地完成，不会上传。'),
        h('button', { class: 'btn blue block', id: 'register', disabled: busy || !oldCanvas }, busy ? '正在多尺度配准与差异分析…' : '自动配准并高亮差异'),
        h('label', { class: 'field' }, '老拓片叠合透明度',
          h('div', { class: 'range-row' }, opacityInput = h('input', { type: 'range', min: 0, max: 100, value: Math.round(opacity * 100) }) as HTMLInputElement, h('span', { class: 'range-value' }, `${Math.round(opacity * 100)}%`)),
        ),
        h('label', { class: 'switch-row' }, '显示差异高亮', diffCheck),
        h('div', { id: 'diff-summary' }, diff ? summaryCard(diff) : h('div', { class: 'badge' }, '尚未完成差异分析')),
        h('div', { id: 'region-list' }, diff ? regionList(diff) : null),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn small', disabled: !diff, onclick: exportDiffPng }, '导出校勘图 PNG'),
          h('button', { class: 'btn small', disabled: !compareRecord.oldPhotoBlob, onclick: async () => {
            if (compareRecord.oldPhotoBlob) downloadBlob(compareRecord.oldPhotoBlob, 'old-rubbing-photo.jpg');
          } }, '下载老拓片'),
        ),
      ),
    );
    const fileInput = panel.querySelector('input[type=file]') as HTMLInputElement | null;
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) await loadImageBlob(file);
    });
    panel.querySelector('#sample-old')?.addEventListener('click', loadSampleOld);
    panel.querySelector('#register')?.addEventListener('click', runRegistration);
    opacityInput?.addEventListener('input', (e) => {
      drawLayers();
      const val = panel.querySelector('.range-value');
      if (val) val.textContent = `${(e.currentTarget as HTMLInputElement).value}%`;
    });
    diffCheck.addEventListener('change', drawLayers);
  }

  let opacityInput: HTMLInputElement | null = null;
  const diffCheck = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;

  async function loadImageBlob(blob: Blob): Promise<void> {
    compareRecord.oldPhotoBlob = blob;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片无法解码'));
      img.src = objectUrl!;
    });
    oldCanvas = makeCanvasFromImage(img, 760);
    oldGray = imageDataToGray(oldCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, oldCanvas.width, oldCanvas.height));
    transform = null;
    diff = null;
    toast('老拓片已载入，开始自动配准', 'success');
    renderPanel(false, '已载入，正在配准…');
    await runRegistration();
  }

  async function loadSampleOld(): Promise<void> {
    const scans = (await db.scans.byStele(scan.steleId)).sort((a, b) => a.createdAt - b.createdAt);
    const oldScan = scans[0] ?? scan;
    toast('正在用初扫生成带旋转、纸纹和旧照片噪点的老拓片…', 'info', 3000);
    const blob = await createOldPhotoBlob(oldScan, doc.params);
    await loadImageBlob(blob);
  }

  async function runRegistration(): Promise<void> {
    if (!oldCanvas || !oldGray) return toast('请先上传或生成老拓片', 'warning');
    renderPanel(true, '正在搜索旋转、缩放和平移…');
    await new Promise((r) => setTimeout(r, 60));
    try {
      transform = registerGray(oldGray, digitalGray);
      const alignedGray = warpGray(oldGray, targetW, targetH, transform);
      diff = computeDiff(digitalGray, alignedGray, transform.score);
      compareRecord.transform = transform;
      compareRecord.diffSummary = { ...diff };
      compareRecord.updatedAt = Date.now();
      await db.compares.put(compareRecord);
      drawLayers();
      renderPanel(false, `配准相关度 ${(transform.score * 100).toFixed(1)}% · 旋转 ${transform.rotationDeg.toFixed(2)}° · 缩放 ${transform.scale.toFixed(3)}`);
      toast('自动配准与差异分析完成', 'success');
    } catch (error) {
      console.error(error);
      toast(error instanceof Error ? error.message : '配准失败', 'error');
      renderPanel(false, '配准失败');
    }
  }

  function drawLayers(): void {
    const ctx = oldLayer.getContext('2d')!;
    ctx.clearRect(0, 0, targetW, targetH);
    if (oldCanvas && transform) {
      const opacity = opacityInput ? Number(opacityInput.value) / 100 : 0.52;
      drawAlignedImage(ctx, oldCanvas, oldCanvas.width, oldCanvas.height, targetW, targetH, transform, opacity);
    } else if (oldCanvas) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(oldCanvas, 0, 0, targetW, targetH);
      ctx.globalAlpha = 1;
    }

    const dctx = diffLayer.getContext('2d')!;
    dctx.clearRect(0, 0, targetW, targetH);
    regionLayer.replaceChildren();
    if (diff && diffCheck.checked) {
      const image = dctx.createImageData(targetW, targetH);
      for (let i = 0; i < diff.newMask.length; i++) {
        if (diff.newMask[i]) {
          image.data[i * 4] = 255; image.data[i * 4 + 1] = 54; image.data[i * 4 + 2] = 24; image.data[i * 4 + 3] = 105;
        } else if (diff.oldOnlyMask[i]) {
          image.data[i * 4] = 40; image.data[i * 4 + 1] = 160; image.data[i * 4 + 2] = 255; image.data[i * 4 + 3] = 80;
        }
      }
      dctx.putImageData(image, 0, 0);
      for (const region of diff.regions.slice(0, 35)) {
        const box = h('div', {
          class: `region-box ${region.kind === 'old-loss' ? 'old-loss' : ''}`,
          style: `left:${region.x * 100}%;top:${region.y * 100}%;width:${region.w * 100}%;height:${region.h * 100}%`,
          title: `${region.kind} area=${region.area}`,
        }, h('span', { class: 'region-label' }, region.kind === 'new-loss' ? `新泐 ${region.area}px` : `异文 ${region.area}px`));
        regionLayer.append(box);
      }
    }
  }

  function summaryCard(d: DiffResult): HTMLElement {
    return h('div', { class: 'grid', style: 'gap:9px' },
      h('div', { class: 'stat-grid', style: 'grid-template-columns:1fr 1fr' },
        h('div', { class: 'stat good' }, h('div', { class: 'label' }, '配准分数'), h('div', { class: 'value', style: 'font-size:20px' }, `${(d.score * 100).toFixed(1)}%`)),
        h('div', { class: 'stat bad' }, h('div', { class: 'label' }, '新泐像素'), h('div', { class: 'value', style: 'font-size:20px' }, d.newLossPixels.toLocaleString())),
      ),
      h('p', { style: 'font-size:12px;color:var(--ink-soft);line-height:1.6' }, `识别 ${d.regions.filter((r) => r.kind === 'new-loss').length} 个新增损失区域、${d.regions.filter((r) => r.kind === 'old-loss').length} 个单侧差异。红色为当前数字拓片相对老拓片新增的留白/泐损，蓝色为老拓片独有。`),
    );
  }

  function regionList(d: DiffResult): HTMLElement {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, '类型'), h('th', { class: 'num' }, '面积 px'), h('th', { class: 'num' }, '严重度'))),
      h('tbody', {}, ...d.regions.slice(0, 18).map((r, i) => h('tr', {},
        h('td', {}, String(i + 1)),
        h('td', {}, h('span', { class: `badge ${r.kind === 'new-loss' ? 'seal' : 'blue'}` }, r.kind === 'new-loss' ? '新泐' : '老片独有')),
        h('td', { class: 'num' }, r.area),
        h('td', { class: 'num' }, `${(r.severity * 100).toFixed(0)}%`),
      ))),
    ));
  }

  async function exportDiffPng(): Promise<void> {
    const out = document.createElement('canvas');
    out.width = targetW; out.height = targetH;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(digitalCanvas, 0, 0);
    if (oldCanvas && transform) {
      ctx.globalAlpha = 0.28;
      drawAlignedImage(ctx, oldCanvas, oldCanvas.width, oldCanvas.height, targetW, targetH, transform, 0.28);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(diffLayer, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => out.toBlob((b) => b ? resolve(b) : reject(new Error('PNG 编码失败')), 'image/png'));
    downloadBlob(blob, `compare-${scan.id}.png`);
  }

  renderPanel();
  drawLayers();

  return { destroy: () => { if (objectUrl) URL.revokeObjectURL(objectUrl); } };
};
