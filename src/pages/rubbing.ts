// 拓片生成页：墨包参数调节、乌金/蝉翼预设、局部补墨、撤销
import { repo } from '../db/repo';
import { hideProgress, showProgress, store, toast } from '../state';
import { clear, h, slider } from '../ui/dom';
import { DEFAULT_RUBBING_PARAMS, PRESET_PARAMS, RetouchStroke, RubbingParams } from '../types';
import { getOrCreateSession, getSession } from '../gl/session';

export async function renderRubbingPage(root: HTMLElement): Promise<void> {
  clear(root);
  const scan = store.currentScan();
  const sidebar = h('div', { class: 'sidebar' });
  const stage = h('div', { class: 'stage' });
  root.append(sidebar, stage);

  if (!scan) {
    stage.append(h('div', { class: 'empty' },
      h('div', { style: 'font-size:40px' }, '🖋️'),
      h('div', { textContent: '请先在「扫描处理」页完成一次扫描' }),
      h('button', { class: 'btn', textContent: '去扫描处理', onclick: () => store.update({ route: 'scan' }) })));
    return;
  }

  const scanRec = scan!;
  const hfLoaded = await repo.loadHeightField(scanRec.id);
  if (!hfLoaded) {
    stage.append(h('div', { class: 'empty' }, h('div', { textContent: '高度场数据缺失，请重新处理扫描。' })));
    return;
  }
  const hf = hfLoaded;

  const params: RubbingParams = await repo.getParams(scanRec.id, DEFAULT_RUBBING_PARAMS);
  let strokes: RetouchStroke[] = await repo.getStrokes(scanRec.id);
  const settings = await repo.getSettings();

  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const stageWrap = h('div', {
    style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:crosshair',
  }, canvas);
  stage.append(stageWrap);

  // ---- 视图变换（平移/缩放） ----
  let scale = 1;
  let offX = 0;
  let offY = 0;
  function fitView(): void {
    const rect = stageWrap.getBoundingClientRect();
    scale = Math.min(rect.width / hf.widthPx, rect.height / hf.heightPx) * 0.96;
    offX = (rect.width - hf.widthPx * scale) / 2;
    offY = (rect.height - hf.heightPx * scale) / 2;
    applyTransform();
  }
  function applyTransform(): void {
    canvas.style.width = `${hf.widthPx * scale}px`;
    canvas.style.height = `${hf.heightPx * scale}px`;
    canvas.style.transform = `translate(${offX}px, ${offY}px)`;
    canvas.width = Math.max(2, Math.round(hf.widthPx * scale));
    canvas.height = Math.max(2, Math.round(hf.heightPx * scale));
    render();
  }
  function render(): void {
    const session = getOrCreateSession(canvas, scanRec.id);
    session.engine.setHeightField(hf);
    session.editor.setStrokes(strokes);
    session.engine.renderPreview(canvas, {
      params, strokes, inkColor: settings.inkDark, paperColor: settings.paperLight,
    });
  }

  // ---- 参数面板 ----
  const presetCard = h('div', { class: 'card' }, h('h3', { textContent: '拓法预设' }));
  presetCard.append(h('div', { class: 'btn-row' },
    presetBtn('乌金拓', 'wujin'),
    presetBtn('蝉翼拓', 'chanyi'),
  ));
  sidebar.append(presetCard);

  const paramCard = h('div', { class: 'card' }, h('h3', { textContent: '墨包与墨色' }));
  paramCard.append(
    slider('墨包尺度 mm', 0.4, 4, 0.05, params.inkPouchMm, (v) => { params.inkPouchMm = v; scheduleSave(); render(); }, (v) => v.toFixed(2)),
    slider('墨色浓淡', 0.2, 1, 0.01, params.contrast, (v) => { params.contrast = v; scheduleSave(); render(); }),
    slider('墨阶 Gamma', 0.5, 2.2, 0.01, params.gamma, (v) => { params.gamma = v; scheduleSave(); render(); }),
    slider('刻口锐化', 0, 1, 0.01, params.edgeEnhance, (v) => { params.edgeEnhance = v; scheduleSave(); render(); }),
    slider('石花泐痕', 0, 1, 0.01, params.roughness, (v) => { params.roughness = v; scheduleSave(); render(); }),
    slider('纸张纹理', 0, 1, 0.01, params.paperGrain, (v) => { params.paperGrain = v; scheduleSave(); render(); }),
  );
  sidebar.append(paramCard);

  function presetBtn(name: string, key: 'wujin' | 'chanyi'): HTMLElement {
    return h('button', {
      class: 'btn' + (params.preset === key ? '' : ' ghost'),
      textContent: name,
      onclick: () => {
        Object.assign(params, PRESET_PARAMS[key]);
        repo.saveParams(scanRec.id, params);
        renderRubbingPage(root);
      },
    });
  }

  // ---- 补墨工具 ----
  let tool: 'none' | 'darken' | 'lighten' = 'none';
  let brushMm = 8;
  let brushStrength = 0.35;
  const toolCard = h('div', { class: 'card' }, h('h3', { textContent: '拓工补墨' }));
  const darkenBtn = h('button', { class: 'btn ghost', textContent: '加深（补墨）' }) as HTMLButtonElement;
  const lightenBtn = h('button', { class: 'btn ghost', textContent: '减淡（留白）' }) as HTMLButtonElement;
  darkenBtn.onclick = () => { tool = tool === 'darken' ? 'none' : 'darken'; syncToolBtns(); };
  lightenBtn.onclick = () => { tool = tool === 'lighten' ? 'none' : 'lighten'; syncToolBtns(); };
  function syncToolBtns(): void {
    darkenBtn.className = 'btn' + (tool === 'darken' ? '' : ' ghost');
    lightenBtn.className = 'btn' + (tool === 'lighten' ? '' : ' ghost');
    stageWrap.style.cursor = tool === 'none' ? 'grab' : 'crosshair';
  }
  toolCard.append(
    h('div', { class: 'btn-row' }, darkenBtn, lightenBtn),
    slider('笔径 mm', 2, 40, 0.5, brushMm, (v) => (brushMm = v), (v) => v.toFixed(1)),
    slider('力度', 0.05, 0.9, 0.01, brushStrength, (v) => (brushStrength = v)),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn ghost', textContent: '撤销 Ctrl+Z', onclick: () => doUndo() }),
      h('button', { class: 'btn ghost', textContent: '重做', onclick: () => doRedo() }),
      h('button', { class: 'btn danger', textContent: '清空补墨', onclick: () => {
        const session = getSession();
        session?.editor.clear();
        strokes = [];
        repo.saveStrokes(scanRec.id, strokes);
        render();
        toast('补墨已清空');
      } }),
    ),
  );
  sidebar.append(toolCard);

  const metaCard = h('div', { class: 'card' }, h('h3', { textContent: '数据' }));
  metaCard.append(
    metric('高度场', `${hf.widthPx}×${hf.heightPx} px`),
    metric('分辨率', `${hf.pxPerMm} px/mm（${(1 / hf.pxPerMm).toFixed(2)}mm/px）`),
    metric('基准面 RMS', `${scan.planeFitRmsMm.toFixed(3)} mm`),
  );
  sidebar.append(metaCard);

  // ---- 画布交互 ----
  let dragging = false;
  let painting = false;
  let lastPan = { x: 0, y: 0 };
  function eventToMm(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) / scale;
    const py = (e.clientY - rect.top) / scale;
    return { x: (px / hf.widthPx) * hf.widthMm, y: (py / hf.heightPx) * hf.heightMm };
  }
  canvas.addEventListener('mousedown', (e) => {
    if (tool !== 'none') {
      painting = true;
      applyBrush(e);
    } else {
      dragging = true;
      lastPan = { x: e.clientX - offX, y: e.clientY - offY };
      stageWrap.style.cursor = 'grabbing';
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (painting) applyBrush(e);
    if (dragging) {
      offX = e.clientX - lastPan.x;
      offY = e.clientY - lastPan.y;
      canvas.style.transform = `translate(${offX}px, ${offY}px)`;
    }
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    painting = false;
    if (tool === 'none') stageWrap.style.cursor = 'grab';
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const localX = (mx - offX) / scale;
    const localY = (my - offY) / scale;
    scale = Math.max(0.05, Math.min(8, scale * factor));
    offX = mx - localX * scale;
    offY = my - localY * scale;
    applyTransform();
  }, { passive: false });

  function applyBrush(e: MouseEvent): void {
    if (tool === 'none') return;
    const p = eventToMm(e);
    if (p.x < 0 || p.y < 0 || p.x > hf.widthMm || p.y > hf.heightMm) return;
    const session = getSession()!;
    const strength = (tool === 'darken' ? 1 : -1) * brushStrength;
    const stroke = session.editor.addStroke(p.x, p.y, brushMm, strength);
    strokes = [...session.editor.list()];
    repo.saveStrokes(scanRec.id, strokes);
    render();
    void stroke;
  }

  function doUndo(): void {
    const session = getSession();
    if (session?.editor.undo()) {
      strokes = [...session.editor.list()];
      repo.saveStrokes(scanRec.id, strokes);
      render();
    } else toast('没有可撤销的操作');
  }
  function doRedo(): void {
    const session = getSession();
    if (session?.editor.redo()) {
      strokes = [...session.editor.list()];
      repo.saveStrokes(scanRec.id, strokes);
      render();
    }
  }
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
    }
  });

  // 悬浮工具条
  const toolbar = h('div', { class: 'overlay-toolbar' },
    h('button', { textContent: '适应窗口', onclick: () => fitView() }),
    h('button', { textContent: '100%', onclick: () => { scale = 1; applyTransform(); } }),
    h('button', { textContent: '对比校勘 →', onclick: () => store.update({ route: 'collate' }) }),
    h('button', { textContent: '出版导出 →', onclick: () => store.update({ route: 'export' }) }),
  );
  stage.append(toolbar);
  stage.append(h('div', { class: 'hud', textContent: '滚轮缩放 · 拖拽平移 · 选补墨工具后在画面上落笔' }));

  let saveTimer: number | undefined;
  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => repo.saveParams(scanRec.id, params), 250);
  }

  requestAnimationFrame(() => {
    fitView();
    render();
  });
}

function metric(k: string, v: string): HTMLElement {
  return h('div', { class: 'metric' }, h('span', { textContent: k }), h('b', { textContent: v }));
}
