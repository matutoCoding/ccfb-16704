import { db } from '../db';
import { resetAndSeed } from '../sample';
import { loadState, state } from '../state';
import { h, toast, formatBytes, downloadBlob } from '../ui/dom';
import { evaluateGroundTruthEdges, type EdgeAccuracyReport } from '../geometry/acceptance';
import { renderWholeTiff } from '../export/publish';
import { createEditMask } from '../render/editMask';
import { ensureRubbingDocument } from '../state';
import type { PageRenderer } from './types';

export const renderSettings: PageRenderer = async (view, ctx) => {
  await loadState();
  let edgeReport: EdgeAccuracyReport | null = null;
  let perf: { elapsedMs: number; width: number; height: number; blob: Blob } | null = null;
  let running = '';

  const root = h('div', { class: 'grid cols-2', style: 'grid-template-columns:minmax(320px,.85fr) minmax(0,1.15fr);align-items:start' });
  view.append(root);
  render();

  function render(): void {
    const webgl = webglInfo();
    const scan = state.scans.find((s) => s.id === state.currentScanId) ?? state.scans.find((s) => s.groundTruth);
    root.replaceChildren(
      h('div', { class: 'grid', style: 'gap:16px' },
        generalCard(),
        dataCard(),
        aboutCard(webgl),
      ),
      h('div', { class: 'grid', style: 'gap:16px' },
        accuracyCard(scan),
        performanceCard(scan),
      ),
    );
  }

  function generalCard(): HTMLElement {
    const dpi = h('input', { type: 'number', min: 72, max: 1200, value: state.settings.defaultDpi }) as HTMLInputElement;
    const tile = h('input', { type: 'number', min: 512, max: 4096, step: 256, value: state.settings.tilePx }) as HTMLInputElement;
    const autoSeed = h('input', { type: 'checkbox', checked: state.settings.autoSeed }) as HTMLInputElement;
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, '常规与导出')),
      h('div', { class: 'card-body grid', style: 'gap:12px' },
        h('label', { class: 'field' }, '默认 DPI', dpi),
        h('label', { class: 'field' }, 'WebGL/TIFF 分块边长 px', tile, h('span', { class: 'hint' }, '较小分块更不容易触发纹理上限，较大分块通常更快。')),
        h('label', { class: 'switch-row' }, '空库时自动生成测试样碑', autoSeed),
        h('button', { class: 'btn primary', onclick: async () => {
          state.settings.defaultDpi = Number(dpi.value) || 600;
          state.settings.tilePx = Number(tile.value) || 1536;
          state.settings.autoSeed = autoSeed.checked;
          await db.settings.put(state.settings);
          toast('设置已保存', 'success');
        } }, '保存设置'),
      ),
    );
  }

  function dataCard(): HTMLElement {
    const storagePlaceholder = h('div', { class: 'hint' }, '正在读取存储占用…');
    storageInfo().then((el) => storagePlaceholder.replaceWith(el)).catch(() => undefined);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'IndexedDB 碑库')),
      h('div', { class: 'card-body grid', style: 'gap:12px' },
        storagePlaceholder,
        h('div', { class: 'button-row' },
          h('button', { class: 'btn jade', onclick: async () => {
            await resetAndSeed((m, p) => toast(`${m} ${p}%`, 'info', 900));
            await loadState(); render(); toast('已重建程序样例数据', 'success');
          } }, '重建测试样碑'),
          h('button', { class: 'btn', onclick: async () => {
            if (!confirm('清空 IndexedDB 中所有碑刻、扫描、拓片和校勘记录？此操作不可撤销。')) return;
            await db.reset();
            await loadState();
            render();
            toast('本地碑库已清空', 'success');
          } }, '清空数据库'),
        ),
        h('p', { class: 'hint' }, '网格 typed arrays、老拓片 Blob 与工作稿均保存在当前浏览器 IndexedDB；清除站点数据会一并删除。'),
      ),
    );
  }

  async function storageInfo(): Promise<HTMLElement> {
    const estimate = await db.estimate();
    return h('div', { class: 'kv' },
      h('dt', {}, '当前用量'), h('dd', {}, estimate ? formatBytes(estimate.usage) : '不可用'),
      h('dt', {}, '浏览器配额'), h('dd', {}, estimate ? formatBytes(estimate.quota) : '—'),
      h('dt', {}, '碑刻'), h('dd', {}, String(state.steles.length)),
      h('dt', {}, '扫描'), h('dd', {}, String(state.scans.length)),
    );
  }

  function aboutCard(webgl: string): HTMLElement {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, '技术信息')),
      h('div', { class: 'card-body' },
        h('dl', { class: 'kv' },
          h('dt', {}, '渲染栈'), h('dd', {}, 'TypeScript · WebGL2 · 原生 GLSL'),
          h('dt', {}, '数据'), h('dd', {}, 'IndexedDB object stores'),
          h('dt', {}, '导出'), h('dd', {}, '灰度 TIFF / PNG ZIP / CSV / JSON'),
          h('dt', {}, 'GL'), h('dd', { style: 'font-size:11px' }, webgl),
        ),
        h('div', { class: 'code-block', style: 'margin-top:12px' }, 'npm install\nnpm run dev\nnpm run acceptance   # Node 几何与 TIFF 基础验收\nnpm run build        # tsc + vite production build'),
      ),
    );
  }

  function accuracyCard(scan = state.scans[0]): HTMLElement {
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, '刻口几何精度验收'), h('p', {}, '程序楷书真值轮廓 vs 实际网格深度阈值边界'))),
      h('div', { class: 'card-body grid', style: 'gap:13px' },
        h('div', { class: 'button-row' },
          h('button', { class: 'btn primary', disabled: running !== '' || !scan?.groundTruth, onclick: runEdge }, running === 'edge' ? '正在采样 900 个刻口点…' : '运行边界偏差检测'),
          h('button', { class: 'btn', onclick: () => ctx.navigate('scan') }, '切换扫描'),
        ),
        !scan?.groundTruth ? h('p', { class: 'hint' }, '当前扫描没有程序真值。请使用“重建测试样碑”生成带 GroundTruth 的样例。') :
          h('p', { class: 'hint' }, `扫描：${scan.name}；真值字形 ${scan.groundTruth.glyphs.length} 个，坑洞 ${scan.groundTruth.pits.length} 个。验收阈值 0.20 mm。`),
        edgeReport ? edgeResult(edgeReport) : h('div', { class: 'badge' }, '尚未运行'),
      ),
    );
    return card;
  }

  async function runEdge(): Promise<void> {
    const scan = state.scans.find((s) => s.id === state.currentScanId) ?? state.scans.find((s) => s.groundTruth);
    if (!scan) return;
    running = 'edge'; render();
    await new Promise((r) => setTimeout(r, 40));
    try {
      const doc = await ensureRubbingDocument(scan);
      edgeReport = evaluateGroundTruthEdges(scan, doc.params);
      toast(edgeReport.passed ? '几何精度通过：600DPI P95 偏差 < 0.2mm' : '精度未达到阈值，请检查基准拟合/网格密度', edgeReport.passed ? 'success' : 'warning', 6000);
    } catch (error) {
      toast(error instanceof Error ? error.message : '验收失败', 'error');
    } finally {
      running = ''; render();
    }
  }

  function edgeResult(r: EdgeAccuracyReport): HTMLElement {
    return h('div', { class: 'grid', style: 'gap:11px' },
      h('div', { class: `stat ${r.passed ? 'good' : 'bad'}` },
        h('div', { class: 'label' }, '600DPI 综合 P95 边界偏差'),
        h('div', { class: 'value' }, r.render600P95Mm.toFixed(3), h('span', { class: 'unit' }, 'mm')),
        h('div', { style: 'margin-top:7px' }, h('span', { class: `badge ${r.passed ? 'good' : 'warn'}` }, r.passed ? '通过 < 0.20 mm' : '未通过')),
      ),
      h('div', { class: 'stat-grid', style: 'grid-template-columns:repeat(3,1fr)' },
        miniStat('平均', `${r.meanMm.toFixed(3)} mm`),
        miniStat('RMS', `${r.rmsMm.toFixed(3)} mm`),
        miniStat('最大', `${r.maxMm.toFixed(3)} mm`),
      ),
      h('p', { class: 'hint' }, `样本 ${r.sampleCount}；网格刻口 P95 ${r.p95Mm.toFixed(3)} mm，平均 ${r.meanMm.toFixed(3)} mm。程序字形源轮廓受 ${state.scans.find((s) => s.groundTruth)?.grid?.nx ?? 900}×${state.scans.find((s) => s.groundTruth)?.grid?.ny ?? 2000} 网格离散影响的 P95 为 ${r.sourceTruthP95Mm.toFixed(3)} mm。综合项包含 600DPI 像素量化 ${(25.4 / 600).toFixed(4)} mm。`),
      h('div', {},
        h('div', { class: 'progress-label' }, h('span', {}, '相对 0.20mm 容差')),
        h('div', { class: 'metric-bar threshold' }, h('i', { style: `width:${Math.min(100, (r.render600P95Mm / 0.2) * 100)}%` })),
      ),
    );
  }

  function performanceCard(scan = state.scans[0]): HTMLElement {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, '600 DPI 速度验收'), h('p', {}, '真实创建 WebGL2 引擎并分块编码整张灰度 TIFF'))),
      h('div', { class: 'card-body grid', style: 'gap:12px' },
        h('div', { class: 'button-row' },
          h('button', { class: 'btn primary', disabled: running !== '' || !scan, onclick: runPerf }, running === 'perf' ? '正在渲染全尺寸…' : `执行 ${state.settings.defaultDpi} DPI 整张计时`),
          perf ? h('button', { class: 'btn jade', onclick: () => perf && downloadBlob(perf.blob, 'acceptance-600dpi.tif') }, '保存生成的 TIFF') : null,
        ),
        h('p', { class: 'hint' }, scan ? `目标扫描高 ${scan.heightMm.toFixed(0)} mm、宽 ${scan.widthMm.toFixed(0)} mm，约 ${Math.round(scan.heightMm * state.settings.defaultDpi / 25.4).toLocaleString()} px 高。集显、浏览器和磁盘速度会影响结果。` : '无扫描。'),
        perf ? h('div', { class: `stat ${perf.elapsedMs <= 10000 ? 'good' : 'warn'}` },
          h('div', { class: 'label' }, '端到端渲染 + TIFF 编码'),
          h('div', { class: 'value' }, `${(perf.elapsedMs / 1000).toFixed(2)}`, h('span', { class: 'unit' }, 's')),
          h('div', { style: 'font-size:12px;color:var(--ink-soft);margin-top:5px' }, `${perf.width}×${perf.height} · ${formatBytes(perf.blob.size)}`),
        ) : null,
      ),
    );
  }

  async function runPerf(): Promise<void> {
    const scan = state.scans.find((s) => s.id === state.currentScanId) ?? state.scans[0];
    if (!scan) return;
    running = 'perf'; render();
    try {
      const doc = await ensureRubbingDocument(scan);
      const mask = createEditMask(scan, doc);
      const result = await renderWholeTiff(scan, doc.params, state.settings.defaultDpi, {
        tilePx: state.settings.tilePx,
        editSource: mask,
        onProgress: (p) => toast(`${p.phase} ${p.done}/${p.total}`, 'info', 700),
      });
      perf = { elapsedMs: result.elapsedMs, width: result.width, height: result.height, blob: result.blob };
      toast(`导出完成：${(result.elapsedMs / 1000).toFixed(2)}s`, result.elapsedMs <= 10000 ? 'success' : 'warning', 7000);
    } catch (error) {
      console.error(error);
      toast(error instanceof Error ? error.message : '性能验收失败', 'error', 8000);
    } finally {
      running = ''; render();
    }
  }
};

function miniStat(label: string, value: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value', style: 'font-size:17px' }, value));
}

function webglInfo(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return 'WebGL2 不可用';
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    return `${renderer}; GLSL ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`;
  } catch {
    return '无法读取';
  }
}
