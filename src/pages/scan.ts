// 扫描处理页：导入网格 -> Worker 内基准面拟合去倾斜/弯曲 -> 高度场入库
import { repo } from '../db/repo';
import { hideProgress, showProgress, store, toast } from '../state';
import { clear, h } from '../ui/dom';
import { processInWorker } from '../workers/process-client';

export async function renderScanPage(root: HTMLElement): Promise<void> {
  clear(root);
  const stele = store.currentStele();
  const sidebar = h('div', { class: 'sidebar' });
  const stage = h('div', { class: 'stage' });
  root.append(sidebar, stage);

  if (!stele) {
    stage.append(h('div', { class: 'empty' },
      h('div', { style: 'font-size:40px' }, '📄'),
      h('div', { textContent: '请先在「碑刻档案」中选择一块碑' }),
      h('button', { class: 'btn', textContent: '去档案页', onclick: () => store.update({ route: 'archive' }) })));
    return;
  }
  const steleRec = stele;

  const resInput = h('input', { type: 'number', value: '5', min: '2', max: '12', step: '1' }) as HTMLInputElement;
  const labelInput = h('input', { type: 'text', placeholder: '扫描批次标签', value: `扫描 ${new Date().toLocaleDateString()}` }) as HTMLInputElement;

  const card = h('div', { class: 'card' },
    h('h3', { textContent: `当前碑刻：${stele.name}` }),
    h('div', { class: 'muted', textContent: '支持 PLY（ascii / 二进制）与 OBJ，数百万面在 Web Worker 后台处理，不阻塞界面。' }),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('label', { textContent: '标签' }), labelInput),
    h('div', { class: 'row' }, h('label', { textContent: '采样 px/mm' }), resInput,
      h('span', { class: 'muted', textContent: '5 = 0.2mm 间隔' })),
  );

  const fileInput = h('input', {
    type: 'file', accept: '.ply,.obj', style: 'display:none',
    onchange: async () => {
      const f = fileInput.files?.[0];
      if (f) await handleFile(f, () => Number(resInput.value) || 5, labelInput.value || f.name);
      fileInput.value = '';
    },
  }) as HTMLInputElement;

  card.append(
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn', textContent: '导入 PLY / OBJ', onclick: () => fileInput.click() }),
      h('button', {
        class: 'btn ghost', textContent: '载入内置测试碑（115万顶点）',
        onclick: () => runWorker({ kind: 'generated', pxPerMm: Number(resInput.value) || 5 }, labelInput.value || '内置测试扫描', 'browser-generated-stele', 'generated'),
      }),
    ),
    fileInput,
  );
  sidebar.append(card);

  const info = h('div', { class: 'card' }, h('h3', { textContent: '处理流程（Worker 后台线程）' }));
  info.append(
    step('1', 'PCA 拟合基准面，估计法向并去除整体倾斜'),
    step('2', '变换到基准面局部坐标（凸起为正、凹陷为负）'),
    step('3', '规则网格逆映射 / 通用三角形光栅化为高度场'),
    step('4', '二次曲面去趋势，去除碑面整体弯曲'),
    step('5', '空洞邻域填补 + 直方图中位数中性面对齐'),
    step('6', '高度场写入 IndexedDB，挂接到当前碑刻'),
  );
  sidebar.append(info);

  const scans = await repo.listScans(steleRec.id);
  const listCard = h('div', { class: 'card' }, h('h3', { textContent: `本碑扫描（${scans.length}）` }));
  for (const sc of scans) {
    listCard.append(h('div', {
      class: 'list-item' + (store.get().currentScanId === sc.id ? ' selected' : ''),
      onclick: () => store.update({ currentScanId: sc.id, route: 'rubbing' }),
    },
      h('div', { class: 'title', textContent: sc.label }),
      h('div', { class: 'sub', textContent: `${sc.format} · ${(sc.vertexCount / 10000).toFixed(1)}万顶点 · RMS ${sc.planeFitRmsMm.toFixed(3)}mm` })));
  }
  sidebar.append(listCard);

  stage.append(h('div', { class: 'empty' },
    h('div', { style: 'font-size:40px' }, '🧊'),
    h('div', { textContent: '导入网格后在此查看处理进度与几何统计' })));

  async function handleFile(file: File, getRes: () => number, label: string): Promise<void> {
    const buffer = await file.arrayBuffer();
    const format = file.name.toLowerCase().endsWith('.ply') ? 'ply' : 'obj';
    await runWorker({ kind: 'file', name: file.name, buffer, format, pxPerMm: getRes() }, label, file.name, format);
  }

  async function runWorker(
    req: { kind: 'file'; name: string; buffer: ArrayBuffer; format: 'ply' | 'obj'; pxPerMm: number } | { kind: 'generated'; pxPerMm: number },
    label: string,
    sourceName: string,
    format: 'ply' | 'obj' | 'generated',
  ): Promise<void> {
    const t0 = performance.now();
    try {
      const result = await processInWorker(req, (stageText, pct) => showProgress(stageText, pct));
      const rec = {
        id: 'scan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        steleId: steleRec.id,
        label,
        sourceName,
        format,
        vertexCount: result.vertexCount,
        faceCount: result.faceCount,
        widthMm: result.widthMm,
        heightMm: result.heightMm,
        planeFitRmsMm: result.planeRmsMm,
        createdAt: Date.now(),
      };
      showProgress('写入 IndexedDB…', 0.97);
      await repo.saveScan(rec);
      await repo.saveHeightField(rec.id, result.heightField);
      hideProgress();
      store.update({ currentScanId: rec.id, steles: store.get().steles, scans: [...store.get().scans, rec] });
      toast(`处理完成，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      store.update({ route: 'rubbing' });
    } catch (e) {
      hideProgress();
      toast('处理失败：' + (e as Error).message);
    }
  }
}

function step(n: string, text: string): HTMLElement {
  return h('div', { class: 'checkline' }, h('b', { style: 'color:var(--accent)', textContent: n }), h('span', { textContent: text }));
}
