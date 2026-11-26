import { db } from '../db';
import { importScanFile } from '../geometry/importScan';
import { fitBaseline } from '../geometry/fit';
import { loadState, selectScan, selectStele, state } from '../state';
import { h, mount, toast, formatNumber, formatBytes } from '../ui/dom';
import { MeshViewer } from '../render/MeshViewer';
import type { FitParams, ScanRecord } from '../types';
import type { PageRenderer } from './types';

export const renderScan: PageRenderer = async (view, ctx) => {
  await loadState();
  const initialScan = state.scans.find((s) => s.id === state.currentScanId) ?? state.scans.find((s) => s.steleId === state.currentSteleId);
  if (!initialScan) {
    view.append(h('div', { class: 'card' }, h('div', { class: 'empty-state' }, h('div', { class: 'big-icon' }, '三'), h('h3', {}, '还没有可处理的扫描'), h('p', {}, '请先在碑刻档案中生成样例或导入 PLY / OBJ。'), h('button', { class: 'btn primary', onclick: () => ctx.navigate('archive') }, '前往档案页'))));
    return;
  }

  let scan: ScanRecord = initialScan;
  let viewer: MeshViewer | null = null;
  const stage = h('div', { class: 'stage' });
  const canvas = h('canvas', { 'aria-label': '三维碑刻网格预览' }) as HTMLCanvasElement;
  stage.append(
    canvas,
    h('div', { class: 'stage-toolbar' },
      h('span', { class: 'stage-pill' }, '左键旋转 · 滚轮缩放 · 双击复位'),
      h('div', { class: 'stage-actions' },
        h('button', { class: 'btn small', id: 'rotate-btn' }, '自动旋转'),
        h('button', { class: 'btn small', id: 'reset-view' }, '复位视角'),
      ),
    ),
  );

  const controls = h('div', { class: 'card scroll' });
  view.append(h('div', { class: 'layout-work' }, controls, stage));

  try {
    viewer = new MeshViewer(canvas);
    viewer.setScan(scan);
  } catch (error) {
    stage.append(h('div', { class: 'stage-pill', style: 'position:absolute;left:18px;bottom:18px;color:#ffb4a8' }, `WebGL2 初始化失败：${error instanceof Error ? error.message : error}`));
  }

  stage.querySelector('#rotate-btn')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const active = btn.dataset.active === '1';
    btn.dataset.active = active ? '0' : '1';
    btn.classList.toggle('primary', !active);
    viewer?.setAutoRotate(!active);
  });
  stage.querySelector('#reset-view')?.addEventListener('click', () => viewer?.resetView());

  async function refreshScan(next?: ScanRecord): Promise<void> {
    if (next) {
      scan = next;
      state.scans = await db.scans.list();
      await selectScan(next.id);
    } else {
      const fresh = await db.scans.get(scan.id);
      if (fresh) scan = fresh;
    }
    viewer?.setScan(scan);
    renderControls();
  }

  function renderControls(): void {
    const stele = state.steles.find((s) => s.id === scan.steleId);
    const scans = state.scans.filter((s) => s.steleId === scan.steleId);
    const fileInput = h('input', { type: 'file', accept: '.ply,.obj', style: 'display:none' }) as HTMLInputElement;
    const unitSelect = h('select', {},
      h('option', { value: 'auto' }, '单位自动判断'),
      h('option', { value: 'mm' }, '毫米 mm'),
      h('option', { value: 'cm' }, '厘米 cm'),
      h('option', { value: 'm' }, '米 m'),
    ) as HTMLSelectElement;
    const orientCheck = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const correctCheck = h('input', { type: 'checkbox', checked: scan.fit?.corrected ?? true }) as HTMLInputElement;

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        toast(`正在导入并拟合 ${file.name}…`, 'info', 6000);
        const imported = await importScanFile(file, scan.steleId, { unit: unitSelect.value as 'auto', orient: orientCheck.checked });
        await db.scans.put(imported);
        await loadState();
        await selectStele(scan.steleId);
        await selectScan(imported.id);
        ctx.navigate('scan');
        toast('导入完成', 'success');
      } catch (error) {
        toast(error instanceof Error ? error.message : '导入失败', 'error', 8000);
      }
    });

    mount(controls,
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, '扫描与基准面'), h('p', {}, stele?.name ?? ''))),
      h('div', { class: 'card-body grid', style: 'gap:15px' },
        h('label', { class: 'field' }, '当前扫描',
          h('select', {
            onchange: async (e: Event) => {
              const id = (e.target as HTMLSelectElement).value;
              await selectScan(id);
              const next = state.scans.find((s) => s.id === id);
              if (next) await refreshScan(next);
            },
          }, ...scans.map((s) => h('option', { value: s.id, selected: s.id === scan.id }, s.name))),
        ),
        h('div', { class: 'stat-grid', style: 'grid-template-columns:1fr 1fr' },
          stat('顶点', formatNumber(scan.vertexCount)),
          stat('三角面', formatNumber(scan.faceCount)),
          stat('高度', `${scan.heightMm.toFixed(1)} mm`),
          stat('宽度', `${scan.widthMm.toFixed(1)} mm`),
        ),
        h('div', { class: 'kv' },
          h('dt', {}, '深度范围'), h('dd', {}, `${scan.depthMinMm.toFixed(2)} ~ ${scan.depthMaxMm.toFixed(2)} mm`),
          h('dt', {}, '源文件'), h('dd', {}, scan.fileName ?? scan.source),
          h('dt', {}, '存储'), h('dd', {}, formatBytes(scan.positions.byteLength + scan.indices.byteLength)),
        ),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn primary', onclick: async () => {
            toast('正在进行抗差二次曲面拟合…', 'info', 2500);
            await new Promise((r) => setTimeout(r, 30));
            const fit = fitBaseline(scan.positions, { order: 2, robust: true });
            scan.fit = fit;
            await db.scans.put(scan);
            viewer?.setFit(fit);
            renderControls();
            toast(`拟合完成，RMS ${fit.rmsMm.toFixed(4)} mm`, 'success');
          } }, '拟合弯曲基准面'),
          h('button', { class: 'btn', onclick: async () => {
            const fit: FitParams = scan.fit ?? fitBaseline(scan.positions, { order: 1, robust: true });
            fit.order = 1;
            scan.fit = fitBaseline(scan.positions, { order: 1, robust: true });
            await db.scans.put(scan);
            viewer?.setFit(scan.fit);
            renderControls();
          } }, '仅去倾斜平面'),
        ),
        h('label', { class: 'switch-row' }, '显示基准面校正后的碑面', correctCheck),
        (correctCheck.addEventListener('change', () => {
          if (scan.fit) scan.fit.corrected = correctCheck.checked;
          viewer?.setFit(scan.fit);
        }), null),
        scan.fit ? h('div', { class: `stat ${scan.fit.rmsMm < 0.2 ? 'good' : 'warn'}` },
          h('div', { class: 'label' }, '基准面抗差 RMS'),
          h('div', { class: 'value' }, scan.fit.rmsMm.toFixed(4), h('span', { class: 'unit' }, 'mm')),
          h('div', { class: 'hint', style: 'font-size:11px;color:var(--ink-faint);margin-top:4px' }, `最大稳健残差 ${scan.fit.maxAbsMm.toFixed(3)} mm；刻槽与坑洞已通过 IRLS 降权。`),
        ) : h('div', { class: 'badge warn' }, '尚未拟合基准面'),
        h('div', { style: 'height:1px;background:var(--line)' }),
        h('div', { class: 'field' }, h('label', {}, '导入单位')),
        unitSelect,
        h('label', { class: 'switch-row' }, '自动 PCA 摆正碑面', orientCheck),
        h('button', { class: 'btn blue block', onclick: () => fileInput.click() }, '导入新的 PLY / OBJ 扫描'),
        fileInput,
        h('button', { class: 'btn primary block', onclick: () => ctx.navigate('rubbing') }, '使用此扫描生成拓片 →'),
        scan.groundTruth ? h('button', { class: 'btn ghost block', onclick: () => ctx.navigate('settings') }, '运行刻口边界精度验收') : null,
      ),
    );
  }

  renderControls();
  return { destroy: () => viewer?.dispose() };
};

function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value', style: 'font-size:18px' }, value));
}
