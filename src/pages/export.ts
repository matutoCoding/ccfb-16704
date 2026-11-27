// 出版导出页：单字框选编号、批量单字导出（带坐标）、指定 DPI 的 TIFF 整图、几何精度自检
import { repo } from '../db/repo';
import { hideProgress, showProgress, store, toast } from '../state';
import { clear, h } from '../ui/dom';
import { getOrCreateSession } from '../gl/session';
import { cropImage, downloadBlob, encodePng, encodeTiffGray } from '../gl/image';
import { DEFAULT_RUBBING_PARAMS, CharacterBox, uid } from '../types';
import { maskFromGray, unpackGroundTruth, boundaryAccuracy } from '../geometry/accuracy';
import { toGrayscale } from '../gl/image';

export async function renderExportPage(root: HTMLElement): Promise<void> {
  clear(root);
  const scan = store.currentScan();
  const sidebar = h('div', { class: 'sidebar' });
  const stage = h('div', { class: 'stage' });
  root.append(sidebar, stage);

  if (!scan) {
    stage.append(h('div', { class: 'empty' }, h('div', { style: 'font-size:40px' }, '📦'),
      h('div', { textContent: '请先完成一次扫描' })));
    return;
  }
  const scanRec = scan!;
  const hfLoaded = await repo.loadHeightField(scanRec.id);
  if (!hfLoaded) {
    stage.append(h('div', { class: 'empty' }, h('div', { textContent: '高度场数据缺失，请重新处理扫描。' })));
    return;
  }
  const hf = hfLoaded;
  const params = await repo.getParams(scanRec.id, DEFAULT_RUBBING_PARAMS);
  const strokes = await repo.getStrokes(scanRec.id);
  const settings = await repo.getSettings();
  let chars = await repo.getCharacters(scanRec.id);

  const canvas = h('canvas') as HTMLCanvasElement;
  const wrap = h('div', {
    style: 'position:absolute;inset:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:16px',
  }, canvas);
  stage.append(wrap);

  let scale = 1;
  function fit(): void {
    const rect = wrap.getBoundingClientRect();
    scale = Math.min(rect.width / hf.widthPx, rect.height / hf.heightPx) * 0.95;
    canvas.style.width = `${hf.widthPx * scale}px`;
    canvas.style.height = `${hf.heightPx * scale}px`;
    canvas.width = Math.round(hf.widthPx * scale);
    canvas.height = Math.round(hf.heightPx * scale);
    renderAll();
  }

  const session = getOrCreateSession(canvas, scanRec.id + ':export');
  function renderGL(): void {
    session.engine.setHeightField(hf);
    session.editor.setStrokes(strokes);
    session.engine.renderPreview(canvas, {
      params, strokes, inkColor: settings.inkDark, paperColor: settings.paperLight,
    });
  }
  function renderBoxes(): void {
    const ctx = canvas.getContext('2d')!;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#d98b4a';
    ctx.font = '11px sans-serif';
    for (const c of chars) {
      const x = (c.bbox.x / hf.widthMm) * canvas.width;
      const y = (c.bbox.y / hf.heightMm) * canvas.height;
      const w = (c.bbox.w / hf.widthMm) * canvas.width;
      const hgt = (c.bbox.h / hf.heightMm) * canvas.height;
      ctx.strokeRect(x, y, w, hgt);
      ctx.fillStyle = '#d98b4a';
      ctx.fillText(String(c.index + 1), x + 2, y + 12);
      ctx.fillStyle = 'rgba(217,139,74,0.08)';
      ctx.fillRect(x, y, w, hgt);
    }
  }
  function renderAll(): void {
    renderGL();
    renderBoxes();
  }

  // ---- 框选交互 ----
  let drag: { x0: number; y0: number } | null = null;
  let mode: 'box' | 'pan' = 'box';
  canvas.addEventListener('mousedown', (e) => {
    if (mode !== 'box') return;
    const rect = canvas.getBoundingClientRect();
    drag = { x0: (e.clientX - rect.left) / scale, y0: (e.clientY - rect.top) / scale };
  });
  canvas.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const x1 = (e.clientX - rect.left) / scale;
    const y1 = (e.clientY - rect.top) / scale;
    const xMm = Math.min(drag.x0, x1) / hf.pxPerMm;
    const yMm = Math.min(drag.y0, y1) / hf.pxPerMm;
    const wMm = Math.abs(x1 - drag.x0) / hf.pxPerMm;
    const hMm = Math.abs(y1 - drag.y0) / hf.pxPerMm;
    drag = null;
    if (wMm < 2 || hMm < 2) return;
    const box: CharacterBox = {
      id: uid('chr'),
      index: chars.length,
      bbox: { x: xMm, y: yMm, w: wMm, h: hMm },
      label: `字 ${chars.length + 1}`,
    };
    chars = [...chars, box];
    repo.saveCharacters(scanRec.id, chars);
    renderAll();
  });

  // ---- 侧栏 ----
  const dpiInput = h('input', { type: 'number', value: String(settings.defaultDpi), min: '72', max: '1200' }) as HTMLInputElement;
  const boxCard = h('div', { class: 'card' }, h('h3', { textContent: `单字框选（${chars.length}）` }));
  boxCard.append(
    h('div', { class: 'muted', textContent: '在拓片上拖框即可圈选单字并自动编号，坐标以毫米存储。' }),
    h('div', { class: 'btn-row', style: 'margin-top:8px' },
      h('button', {
        class: 'btn ghost', textContent: mode === 'box' ? '✓ 框选模式' : '框选模式',
        onclick: () => { mode = 'box'; wrap.style.cursor = 'crosshair'; toast('已切换框选模式'); },
      }),
      h('button', {
        class: 'btn danger', textContent: '清空全部框',
        onclick: () => { chars = []; repo.saveCharacters(scanRec.id, chars); renderAll(); refreshList(); },
      }),
    ),
  );
  const charList = h('div', { style: 'max-height:200px;overflow-y:auto;margin-top:8px' });
  boxCard.append(charList);
  function refreshList(): void {
    charList.replaceChildren();
    chars.forEach((c) => {
      charList.append(h('div', {
        class: 'list-item',
        onclick: () => toast(`#${c.index + 1} 位置 (${c.bbox.x.toFixed(1)}, ${c.bbox.y.toFixed(1)})mm 尺寸 ${c.bbox.w.toFixed(1)}×${c.bbox.h.toFixed(1)}mm`),
      }, h('div', { class: 'title', textContent: `#${c.index + 1} ${c.label}` }),
        h('div', { class: 'sub', textContent: `${c.bbox.w.toFixed(1)}×${c.bbox.h.toFixed(1)} mm` }),
        h('button', {
          class: 'btn danger', style: 'margin-top:4px', textContent: '删除',
          onclick: () => {
            chars = chars.filter((x) => x.id !== c.id).map((x, i) => ({ ...x, index: i, label: `字 ${i + 1}` }));
            repo.saveCharacters(scanRec.id, chars);
            renderAll();
            refreshList();
          },
        })));
    });
  }
  refreshList();
  sidebar.append(boxCard);

  const exportCard = h('div', { class: 'card' }, h('h3', { textContent: '出版导出' }));
  exportCard.append(
    h('div', { class: 'row' }, h('label', { textContent: 'DPI' }), dpiInput),
    h('div', { class: 'muted', id: 'size-hint', textContent: sizeHint(Number(dpiInput.value)) }),
    h('div', { class: 'btn-row', style: 'margin-top:8px' },
      h('button', { class: 'btn', textContent: '整张 TIFF', onclick: () => exportFull('tiff') }),
      h('button', { class: 'btn ghost', textContent: '整张 PNG', onclick: () => exportFull('png') }),
      h('button', { class: 'btn', textContent: '批量单字 PNG+坐标', onclick: exportCharacters }),
    ),
  );
  dpiInput.oninput = () => {
    (exportCard.querySelector('#size-hint') as HTMLElement).textContent = sizeHint(Number(dpiInput.value));
  };
  sidebar.append(exportCard);

  // ---- 性能记录（对照 10 秒验收线）----
  const perfCard = h('div', { class: 'card' }, h('h3', { textContent: '性能记录' }));
  const perfBody = h('div', { class: 'muted', textContent: '尚未导出。出图后在此显示像素规模、分块数与 GPU 渲染耗时。' });
  perfCard.append(perfBody);
  sidebar.append(perfCard);
  function recordPerf(dpi: number, w: number, outH: number, tiles: number, ms: number): void {
    const ok = ms < 10000;
    perfBody.replaceChildren(
      h('div', { class: 'metric' }, h('span', { textContent: `${dpi} DPI 输出` }), h('b', { textContent: `${w}×${outH}` })),
      h('div', { class: 'metric' }, h('span', { textContent: '像素规模' }), h('b', { textContent: `${(w * outH / 1e6).toFixed(0)} MP` })),
      h('div', { class: 'metric' }, h('span', { textContent: 'GPU 分块' }), h('b', { textContent: `${tiles} 块` })),
      h('div', { class: 'metric' + (ok ? ' good' : 'bad') }, h('span', { textContent: '渲染耗时' }), h('b', { textContent: `${(ms / 1000).toFixed(2)} s` })),
      h('div', { class: 'muted', style: 'margin-top:6px', textContent: ok ? '满足 10 秒验收线' : '超过 10 秒，可调低分块边长或 DPI' }),
    );
  }

  // ---- 几何精度自检 ----
  const accCard = h('div', { class: 'card' }, h('h3', { textContent: '几何精度自检' }));
  accCard.append(h('div', { class: 'muted', textContent: '对内置程序生成碑，可加载随附的刻口真值，量化笔画边界偏差。' }));
  const accBody = h('div', { style: 'margin-top:8px' });
  accCard.append(
    h('div', { class: 'btn-row', style: 'margin-top:8px' },
      h('button', { class: 'btn', textContent: '加载真值并校验', onclick: runAccuracy }),
    ),
    accBody,
  );
  sidebar.append(accCard);

  async function exportFull(fmt: 'tiff' | 'png'): Promise<void> {
    const dpi = Number(dpiInput.value) || 600;
    // 输出像素 = 物理尺寸(英寸) * DPI
    const outW = Math.round((hf.widthMm / 25.4) * dpi);
    const outH = Math.round((hf.heightMm / 25.4) * dpi);
    const t0 = performance.now();
    const img = await session.engine.renderFull(outW, outH, {
      params, strokes, inkColor: settings.inkDark, paperColor: settings.paperLight,
      tileSize: settings.gpuTileSize,
      onProgress: (p) => showProgress(`按 ${dpi}DPI 渲染（${outW}×${outH}）…`, p),
    });
    const elapsed = performance.now() - t0;
    const tiles = Math.ceil(outW / settings.gpuTileSize) * Math.ceil(outH / settings.gpuTileSize);
    recordPerf(dpi, outW, outH, tiles, elapsed);
    const base = `${scanRec.label.replace(/\s+/g, '_')}_${dpi}dpi`;
    if (fmt === 'tiff') {
      downloadBlob(encodeTiffGray(img, dpi), `${base}.tiff`);
    } else {
      downloadBlob(await encodePng(img), `${base}.png`);
    }
    hideProgress();
    toast(`导出完成，渲染耗时 ${(elapsed / 1000).toFixed(1)}s`);
  }

  async function exportCharacters(): Promise<void> {
    if (!chars.length) return toast('请先框选单字');
    const dpi = Number(dpiInput.value) || 600;
    // 单字导出基于当前高度场全分辨率渲染一次再裁切，保证坐标一致
    const full = await session.engine.renderFull(hf.widthPx, hf.heightPx, {
      params, strokes, inkColor: settings.inkDark, paperColor: settings.paperLight,
      tileSize: settings.gpuTileSize,
      onProgress: (p) => showProgress('渲染全图用于单字裁切…', p),
    });
    hideProgress();
    const manifest = {
      sourceScan: scanRec.id,
      sourceLabel: scanRec.label,
      dpi,
      pxPerMm: hf.pxPerMm,
      widthMm: hf.widthMm,
      heightMm: hf.heightMm,
      characters: [] as Record<string, unknown>[],
    };
    for (const c of chars) {
      const crop = cropImage(full, hf.widthMm, hf.heightMm, c.bbox);
      const blob = await encodePng(crop);
      downloadBlob(blob, `${scanRec.id}_char_${String(c.index + 1).padStart(3, '0')}.png`);
      manifest.characters.push({
        index: c.index + 1,
        label: c.label,
        bboxMm: c.bbox,
        bboxPx: {
          x: Math.round(c.bbox.x * hf.pxPerMm),
          y: Math.round(c.bbox.y * hf.pxPerMm),
          w: Math.round(c.bbox.w * hf.pxPerMm),
          h: Math.round(c.bbox.h * hf.pxPerMm),
        },
        file: `${scanRec.id}_char_${String(c.index + 1).padStart(3, '0')}.png`,
      });
    }
    downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), `${scanRec.id}_characters.json`);
    toast(`已导出 ${chars.length} 个单字及坐标清单`);
  }

  async function runAccuracy(): Promise<void> {
    try {
      const resp = await fetch('./testdata/stele-groundtruth.bin');
      if (!resp.ok) throw new Error('真值文件不存在（仅内置测试碑可用）');
      const buf = await resp.arrayBuffer();
      const { mask: gtMask, pxPerMm: gtRes } = unpackGroundTruth(buf);
      showProgress('渲染校验拓片…', 0.3);
      // 渲染到与真值同分辨率
      const img = await session.engine.renderFull(gtMask.width, gtMask.height, {
        params, strokes, inkColor: settings.inkDark, paperColor: settings.paperLight,
        tileSize: settings.gpuTileSize, onProgress: (p) => showProgress('渲染校验拓片…', p),
      });
      showProgress('计算边界偏差…', 0.9);
      const gray = toGrayscale(img);
      const pred = maskFromGray(gray, gtMask.width, gtMask.height);
      const m = boundaryAccuracy(pred, gtMask, gtRes);
      hideProgress();
      accBody.replaceChildren(
        metricRow('平均边界偏差', `${m.meanMm.toFixed(4)} mm`, m.meanMm < 0.2),
        metricRow('RMS 边界偏差', `${m.rmsMm.toFixed(4)} mm`, m.rmsMm < 0.2),
        metricRow('最大边界偏差', `${m.maxMm.toFixed(3)} mm`, m.maxMm < 0.5),
        metricRow('IoU', m.iou.toFixed(4), m.iou > 0.9),
        metricRow('F1', m.f1.toFixed(4), m.f1 > 0.9),
        metricRow('像素误分率', (m.pixelErrorRate * 100).toFixed(2) + '%', m.pixelErrorRate < 0.05),
      );
      toast(m.meanMm < 0.2 ? '精度达标（<0.2mm）' : '精度未达标，请检查参数');
    } catch (e) {
      hideProgress();
      toast('校验失败：' + (e as Error).message);
    }
  }

  function metricRow(k: string, v: string, good: boolean): HTMLElement {
    return h('div', { class: 'metric' + (good ? ' good' : 'bad') },
      h('span', { textContent: k }), h('b', { textContent: v }));
  }

  function sizeHint(dpi: number): string {
    const w = Math.round((hf.widthMm / 25.4) * dpi);
    const h = Math.round((hf.heightMm / 25.4) * dpi);
    return `输出尺寸 ${w}×${h} px（${hf.widthMm}mm 碑 @${dpi}DPI）`;
  }

  stage.append(h('div', { class: 'overlay-toolbar' },
    h('button', { textContent: '适应窗口', onclick: fit }),
    h('button', { textContent: '← 对比校勘', onclick: () => store.update({ route: 'collate' }) }),
  ));
  requestAnimationFrame(fit);
}
