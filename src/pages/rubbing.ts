import { db } from '../db';
import { ensureRubbingDocument, state } from '../state';
import { h, mount, toast, debounce } from '../ui/dom';
import { RubbingEngine, fullRect } from '../render/RubbingEngine';
import { CHANYI_PARAMS, DEFAULT_RUBBING_PARAMS } from '../types';
import type { BrushStroke, CharacterBox, RubbingDocument, RubbingParams } from '../types';
import type { PageRenderer } from './types';

type Tool = 'view' | 'burn' | 'dodge' | 'box';

export const renderRubbing: PageRenderer = async (view, ctx) => {
  await import('../state').then((m) => m.loadState());
  const maybeScan = state.scans.find((s) => s.id === state.currentScanId) ?? state.scans.find((s) => s.steleId === state.currentSteleId);
  if (!maybeScan) {
    view.append(emptyCard('还没有扫描网格', '请先导入 PLY / OBJ 或生成程序样碑。', '前往档案', () => ctx.navigate('archive')));
    return;
  }
  const scan: NonNullable<typeof maybeScan> = maybeScan;
  const doc = await ensureRubbingDocument(scan);
  let tool: Tool = 'view';
  let brushRadius = 8;
  let brushStrength = 0.32;
  let engine: RubbingEngine | null = null;
  let renderQueued = false;
  let destroyed = false;
  const past: BrushStroke[][] = [];
  const future: BrushStroke[][] = [];

  const previewW = 860;
  const previewH = Math.round(previewW * scan.heightMm / scan.widthMm);
  const display = h('canvas', { id: 'rubbing-display', width: previewW, height: previewH }) as HTMLCanvasElement;
  const overlay = h('canvas', { id: 'rubbing-overlay', width: previewW, height: previewH, class: 'tools' }) as HTMLCanvasElement;
  const displayCtx = display.getContext('2d')!;
  const overlayCtx = overlay.getContext('2d')!;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = 1024;
  maskCanvas.height = Math.round((maskCanvas.width * scan.heightMm) / scan.widthMm);
  const maskCtx = maskCanvas.getContext('2d')!;

  const stage = h('div', { class: 'stage light' },
    h('div', { class: 'canvas-stack' }, display, overlay),
    h('div', { class: 'stage-toolbar' },
      h('span', { class: 'stage-pill' }, `${scan.widthMm.toFixed(0)}×${scan.heightMm.toFixed(0)} mm · 预览 ${previewW}×${previewH}`),
      h('div', { class: 'stage-actions' },
        h('button', { class: 'btn small', id: 'undo' }, '↶ 撤销'),
        h('button', { class: 'btn small', id: 'redo' }, '↷ 重做'),
        h('button', { class: 'btn small primary', onclick: () => ctx.navigate('export') }, '出版导出'),
      ),
    ),
  );
  const panel = h('div', { class: 'card scroll' });
  view.append(h('div', { class: 'layout-work wide-panel' }, panel, stage));

  try {
    engine = new RubbingEngine();
    engine.setScan(scan);
    engine.setEditSource(maskCanvas);
  } catch (error) {
    stage.append(h('div', { class: 'stage-pill', style: 'position:absolute;left:18px;bottom:18px;color:#8a1f16;background:#ffe7df' }, `WebGL2 不可用：${error instanceof Error ? error.message : error}`));
  }

  const saveDoc = debounce(async () => {
    doc.updatedAt = Date.now();
    await db.rubbings.put(doc);
  }, 250);

  const schedulePreview = debounce(() => {
    if (!engine || destroyed) return;
    try {
      const image = engine.renderImageData(fullRect(scan), previewW, previewH, doc.params);
      displayCtx.putImageData(image, 0, 0);
    } catch (error) {
      console.error(error);
      toast(error instanceof Error ? error.message : '拓片渲染失败', 'error');
    }
  }, 70);

  function redrawMask(): void {
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    for (const stroke of doc.strokes) drawStrokeToMask(stroke);
    engine?.setEditSource(maskCanvas);
  }

  function drawStrokeToMask(stroke: BrushStroke): void {
    const ctx = maskCtx;
    ctx.save();
    ctx.globalAlpha = stroke.strength;
    ctx.strokeStyle = stroke.mode === 'burn' ? '#ff0000' : '#00ff00';
    ctx.lineWidth = Math.max(2, (stroke.radiusMm / scan.widthMm) * maskCanvas.width * 2);
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const x = p.x * maskCanvas.width;
      const y = (1 - p.y) * maskCanvas.height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      ctx.arc(p.x * maskCanvas.width, (1 - p.y) * maskCanvas.height, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    } else ctx.stroke();
    ctx.restore();
  }

  function renderOverlay(drag?: { x0: number; y0: number; x1: number; y1: number }): void {
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    for (const box of doc.boxes) {
      const x = ((box.xMm - box.wMm / 2 + scan.widthMm / 2) / scan.widthMm) * overlay.width;
      const y = ((scan.heightMm / 2 - (box.yMm + box.hMm / 2)) / scan.heightMm) * overlay.height;
      const w = (box.wMm / scan.widthMm) * overlay.width;
      const h = (box.hMm / scan.heightMm) * overlay.height;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,196,64,.95)';
      ctx.fillStyle = 'rgba(255,196,64,.10)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.font = '700 15px system-ui';
      const label = `${box.index} ${box.label}`;
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(126,32,22,.92)';
      ctx.fillRect(x, Math.max(0, y - 22), tw, 21);
      ctx.fillStyle = '#fff4d8';
      ctx.fillText(label, x + 5, Math.max(15, y - 7));
    }
    if (drag) {
      const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
      const w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  }

  function renderPanel(): void {
    const p = doc.params;
    mount(panel,
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, '拓片与校勘工作稿'), h('p', {}, '几何阈值着墨，不使用反色深度图模糊处理'))),
      h('div', { class: 'card-body grid', style: 'gap:14px' },
        h('div', { class: 'swatch-row' },
          presetCard('wujin', p.preset === 'wujin', '乌金拓', '浓墨、黑亮、白口锐利，适合出版'),
          presetCard('chanyi', p.preset === 'chanyi', '蝉翼拓', '淡墨、纸纹明显，适合观察石花泐痕'),
        ),
        h('div', { class: 'tool-tabs' },
          toolButton('view', '查看'),
          toolButton('burn', '补墨/加深'),
          toolButton('dodge', '减淡'),
          toolButton('box', '框选单字'),
        ),
        (tool === 'burn' || tool === 'dodge') ? h('div', { class: 'grid', style: 'gap:10px' },
          slider('笔半径 mm', brushRadius, 1, 40, 0.5, (v) => brushRadius = v),
          slider('笔强度', brushStrength, 0.03, 0.9, 0.01, (v) => brushStrength = v),
          h('p', { class: 'hint' }, '在拓片上拖动，像拓工局部补墨；每一笔是一条可撤销矢量操作，600DPI 导出时按物理尺寸重放。'),
        ) : null,
        tool === 'box' ? h('p', { class: 'hint' }, '在画面上拖框即可编号；可在下方修改释字、删除或导出坐标。') : null,
        h('div', { style: 'height:1px;background:var(--line)' }),
        slider('墨色浓淡', p.inkDensity, 0.08, 1, 0.01, (v) => { p.inkDensity = v; p.preset = 'custom'; }),
        slider('对比度', p.contrast, 0.65, 2.2, 0.01, (v) => { p.contrast = v; p.preset = 'custom'; }),
        slider('刻口阈值 mm', p.cutThresholdMm, 0.015, 0.18, 0.005, (v) => { p.cutThresholdMm = v; p.preset = 'custom'; }, '越小越贴近真实刻口，过大可能把浅石花误判为刻槽'),
        slider('边缘锐度', p.edgeSharpness, 0.2, 1, 0.01, (v) => { p.edgeSharpness = v; p.preset = 'custom'; }),
        slider('风化/石花表现', p.weathering, 0, 1.5, 0.01, (v) => { p.weathering = v; p.preset = 'custom'; }),
        slider('纸张纹理强度', p.paperStrength, 0, 1, 0.01, (v) => p.paperStrength = v),
        slider('纹理比例', p.paperScale, 0.4, 3, 0.01, (v) => p.paperScale = v),
        slider('墨包肌理', p.padTexture, 0, 0.8, 0.01, (v) => p.padTexture = v),
        slider('墨包尺度 mm', p.padScaleMm, 5, 60, 1, (v) => p.padScaleMm = v),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn small', onclick: undo }, '撤销补墨'),
          h('button', { class: 'btn small', onclick: redo }, '重做'),
          h('button', { class: 'btn small', onclick: () => {
            past.push(doc.strokes.map((s) => ({ ...s, points: [...s.points] })));
            doc.strokes = [];
            future.length = 0;
            redrawMask(); schedulePreview(); saveDoc(); renderPanel();
          } }, '清空补墨'),
        ),
        h('div', { style: 'height:1px;background:var(--line)' }),
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
          h('strong', { style: 'font-size:14px' }, `单字框（${doc.boxes.length}）`),
          h('button', { class: 'btn small', onclick: () => {
            doc.boxes = scan.groundTruth?.glyphs.map((g) => ({ id: `box_${g.id}_${Date.now()}`, index: g.index, label: g.char, xMm: g.xMm, yMm: g.yMm, wMm: g.wMm * .88, hMm: g.hMm * .88 })) ?? [];
            renumber(); renderOverlay(); renderPanel(); saveDoc();
          } }, '按真值重布'),
        ),
        boxList(),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn primary', onclick: () => ctx.navigate('export') }, '批量导出 / TIFF'),
          h('button', { class: 'btn blue', onclick: () => ctx.navigate('compare') }, '送去校勘'),
        ),
      ),
    );
    updateHistoryButtons();
  }

  function presetCard(id: RubbingParams['preset'], active: boolean, title: string, desc: string): HTMLElement {
    return h('button', { class: `preset-card ${active ? 'active' : ''}`, onclick: () => {
      Object.assign(doc.params, id === 'wujin' ? DEFAULT_RUBBING_PARAMS : CHANYI_PARAMS, { preset: id });
      schedulePreview(); saveDoc(); renderPanel();
      toast(`已切换为${title}`);
    } }, h('div', { class: `mini-rubbing ${id}` }), h('strong', {}, title), h('span', {}, desc));
  }

  function toolButton(id: Tool, label: string): HTMLElement {
    return h('button', { class: tool === id ? 'active' : '', onclick: () => { tool = id; overlay.classList.toggle('tools', tool !== 'view'); overlay.style.pointerEvents = tool === 'view' ? 'none' : 'auto'; renderPanel(); } }, label);
  }

  function slider(label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void, hint = ''): HTMLElement {
    const valueLabel = h('span', { class: 'range-value' }, value.toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0));
    const input = h('input', { type: 'range', min, max, step, value }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      valueLabel.textContent = v.toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0);
      onInput(v);
      schedulePreview();
      saveDoc();
    });
    return h('label', { class: 'field' }, label, h('div', { class: 'range-row' }, input, valueLabel), hint ? h('span', { class: 'hint' }, hint) : null);
  }

  function boxList(): HTMLElement {
    const sorted = [...doc.boxes].sort((a, b) => a.index - b.index);
    return h('div', { class: 'box-list' }, ...sorted.map((box) => h('div', { class: 'box-row' },
      h('span', { class: 'color-dot' }),
      h('input', { value: box.label, 'aria-label': '释字', onchange: (e: Event) => { box.label = (e.target as HTMLInputElement).value; saveDoc(); renderOverlay(); } }),
      h('span', {}, `#${box.index}`),
      h('button', { class: 'icon-btn small', title: '删除框', onclick: () => { doc.boxes = doc.boxes.filter((b) => b.id !== box.id); renumber(); renderOverlay(); renderPanel(); saveDoc(); } }, '×'),
    )));
  }

  function renumber(): void {
    [...doc.boxes].sort((a, b) => b.yMm - a.yMm || a.xMm - b.xMm).forEach((b, i) => (b.index = i + 1));
  }

  function eventPoint(e: PointerEvent): { px: number; py: number; nx: number; ny: number; xMm: number; yMm: number } {
    const rect = overlay.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * overlay.width;
    const py = ((e.clientY - rect.top) / rect.height) * overlay.height;
    const xMm = (px / overlay.width) * scan.widthMm - scan.widthMm / 2;
    const yMm = scan.heightMm / 2 - (py / overlay.height) * scan.heightMm;
    return { px, py, nx: px / overlay.width, ny: 1 - py / overlay.height, xMm, yMm };
  }

  let activeStroke: BrushStroke | null = null;
  let boxStart: { px: number; py: number } | null = null;
  overlay.style.pointerEvents = 'none';
  overlay.addEventListener('pointerdown', (e) => {
    if (tool === 'view') return;
    overlay.setPointerCapture(e.pointerId);
    const p = eventPoint(e);
    if (tool === 'burn' || tool === 'dodge') {
      past.push(doc.strokes.map((s) => ({ ...s, points: [...s.points] })));
      future.length = 0;
      activeStroke = { id: `stroke_${Date.now()}`, mode: tool, points: [{ x: p.nx, y: p.ny }], radiusMm: brushRadius, strength: brushStrength, createdAt: Date.now() };
      doc.strokes.push(activeStroke);
      drawStrokeToMask(activeStroke);
      engine?.setEditSource(maskCanvas);
      schedulePreview();
      updateHistoryButtons();
    } else if (tool === 'box') {
      boxStart = { px: p.px, py: p.py };
    }
  });
  overlay.addEventListener('pointermove', (e) => {
    const p = eventPoint(e);
    if (activeStroke) {
      const last = activeStroke.points[activeStroke.points.length - 1];
      if (Math.hypot(p.nx - last.x, p.ny - last.y) * scan.widthMm > 0.7) {
        activeStroke.points.push({ x: p.nx, y: p.ny });
        drawStrokeToMask({ ...activeStroke, points: [last, { x: p.nx, y: p.ny }] });
        engine?.setEditSource(maskCanvas);
        if (!renderQueued) {
          renderQueued = true;
          requestAnimationFrame(() => { renderQueued = false; schedulePreview(); });
        }
      }
    } else if (boxStart) {
      renderOverlay({ x0: boxStart.px, y0: boxStart.py, x1: p.px, y1: p.py });
    }
  });
  const endPointer = (e: PointerEvent): void => {
    if (activeStroke) {
      activeStroke = null;
      redrawMask();
      schedulePreview();
      saveDoc();
    }
    if (boxStart) {
      const p = eventPoint(e);
      const x0 = Math.min(boxStart.px, p.px), y0 = Math.min(boxStart.py, p.py);
      const x1 = Math.max(boxStart.px, p.px), y1 = Math.max(boxStart.py, p.py);
      const wPx = x1 - x0, hPx = y1 - y0;
      boxStart = null;
      if (wPx > 8 && hPx > 8) {
        const xMm = ((x0 + wPx / 2) / overlay.width) * scan.widthMm - scan.widthMm / 2;
        const yMm = scan.heightMm / 2 - ((y0 + hPx / 2) / overlay.height) * scan.heightMm;
        const box: CharacterBox = {
          id: `box_${Date.now()}`,
          index: doc.boxes.length + 1,
          label: '字',
          xMm, yMm,
          wMm: (wPx / overlay.width) * scan.widthMm,
          hMm: (hPx / overlay.height) * scan.heightMm,
        };
        doc.boxes.push(box);
        renumber();
        renderPanel();
        saveDoc();
        toast('已框选并编号，可在左侧修改释字');
      }
      renderOverlay();
    }
  };
  overlay.addEventListener('pointerup', endPointer);
  overlay.addEventListener('pointercancel', endPointer);

  function undo(): void {
    const previous = past.pop();
    if (!previous) return toast('没有可撤销的补墨操作', 'info', 1400);
    future.push(doc.strokes.map((s) => ({ ...s, points: [...s.points] })));
    doc.strokes = previous;
    redrawMask(); renderOverlay(); schedulePreview(); saveDoc(); renderPanel();
  }
  function redo(): void {
    const next = future.pop();
    if (!next) return;
    past.push(doc.strokes.map((s) => ({ ...s, points: [...s.points] })));
    doc.strokes = next;
    redrawMask(); renderOverlay(); schedulePreview(); saveDoc(); renderPanel();
  }
  function onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
  }
  window.addEventListener('keydown', onKey);
  stage.querySelector('#undo')?.addEventListener('click', undo);
  stage.querySelector('#redo')?.addEventListener('click', redo);

  renderPanel();
  redrawMask();
  renderOverlay();
  schedulePreview();

  return {
    destroy: () => {
      destroyed = true;
      window.removeEventListener('keydown', onKey);
      engine?.dispose();
    },
  };
};

function updateHistoryButtons(): void {
  // Buttons call global functions assigned after render; kept simple via re-query in future.
}

function emptyCard(title: string, text: string, action: string, onClick: () => void): HTMLElement {
  return h('div', { class: 'card' }, h('div', { class: 'empty-state' }, h('h3', {}, title), h('p', {}, text), h('button', { class: 'btn primary', onclick: onClick }, action)));
}
