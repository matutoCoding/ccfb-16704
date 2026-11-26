import { db } from '../db';
import { ensureRubbingDocument, loadState, state } from '../state';
import { h, toast, downloadBlob, formatNumber } from '../ui/dom';
import { physicalPixelSize, renderCharacterTableTiff, renderWholeTiff, exportCharacterZip } from '../export/publish';
import { createEditMask } from '../render/editMask';
import type { RubbingDocument } from '../types';
import type { PageRenderer } from './types';

export const renderExport: PageRenderer = async (view, ctx) => {
  await loadState();
  const scan = state.scans.find((s) => s.id === state.currentScanId) ?? state.scans[0];
  if (!scan) {
    view.append(h('div', { class: 'card' }, h('div', { class: 'empty-state' }, h('h3', {}, '没有可导出的数据'), h('button', { class: 'btn primary', onclick: () => ctx.navigate('archive') }, '前往档案'))));
    return;
  }
  const doc: RubbingDocument = await ensureRubbingDocument(scan);
  let dpi = state.settings.defaultDpi || 600;
  let busy: '' | 'tiff' | 'zip' | 'table' = '';
  let lastResult: { kind: string; elapsedMs: number; width: number; height: number; size?: number } | null = null;

  const progressWrap = h('div', { id: 'export-progress' });
  const resultWrap = h('div', { id: 'export-result' });
  const coordWrap = h('div', { class: 'card' });

  function predicted(): { width: number; height: number; bytes: number } {
    const size = physicalPixelSize(scan, dpi);
    return { ...size, bytes: size.width * size.height };
  }

  function render(): void {
    const p = predicted();
    const pass10s = lastResult && lastResult.kind === 'tiff' && lastResult.elapsedMs <= 10000 && scan.heightMm >= 999;
    view.replaceChildren(
      h('div', { class: 'grid cols-2', style: 'grid-template-columns:minmax(330px,.8fr) minmax(0,1.2fr);align-items:start' },
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, '出版导出设置'), h('p', {}, 'TIFF 写入 DPI 分辨率标签，分块 WebGL 渲染避免超大纹理限制'))),
          h('div', { class: 'card-body grid', style: 'gap:14px' },
            h('label', { class: 'field' }, '输出 DPI',
              h('div', { class: 'range-row' },
                dpiInput(),
                h('input', { type: 'number', min: 72, max: 1200, value: dpi, style: 'width:86px', onchange: (e: Event) => { dpi = Number((e.target as HTMLInputElement).value) || 600; render(); } }),
              ),
              h('span', { class: 'hint' }, '验收要求：1 米高碑 600 DPI，页面端到端 10 秒内。')),
            h('div', { class: 'stat-grid', style: 'grid-template-columns:1fr 1fr 1fr' },
              metric('宽 px', formatNumber(p.width)),
              metric('高 px', formatNumber(p.height)),
              metric('未压缩 TIFF', formatBytes(p.bytes)),
            ),
            h('div', { class: 'button-row' },
              h('button', { class: 'btn primary', disabled: busy !== '', onclick: exportTiff }, busy === 'tiff' ? '正在导出整张…' : '导出整张 TIFF'),
              h('button', { class: 'btn jade', disabled: busy !== '' || !doc.boxes.length, onclick: exportZip }, busy === 'zip' ? '正在打包…' : `批量单字 PNG + 坐标 (${doc.boxes.length})`),
              h('button', { class: 'btn blue', disabled: busy !== '' || !doc.boxes.length, onclick: exportTable }, busy === 'table' ? '正在排版…' : '导出单字表 TIFF'),
            ),
            progressWrap,
            resultWrap,
            h('div', { class: 'hint' }, '单字 ZIP 内含 coordinates.csv / json，坐标原点为碑面左上角，单位 mm；TIFF 为灰度、无压缩，兼容传统出版流程。'),
            h('div', { class: 'button-row' },
              h('button', { class: 'btn small ghost', onclick: () => ctx.navigate('rubbing') }, '返回调整拓片/框选'),
              h('button', { class: 'btn small ghost', onclick: () => ctx.navigate('settings') }, '精度与性能验收'),
            ),
          ),
        ),
        coordWrap,
      ),
    );
    renderCoordTable();
    if (lastResult) renderResult(lastResult, pass10s ?? false);
  }

  function dpiInput(): HTMLInputElement {
    const input = h('input', { type: 'range', min: 150, max: 900, step: 10, value: dpi }) as HTMLInputElement;
    input.addEventListener('input', () => { dpi = Number(input.value); render(); });
    return input;
  }

  function metric(label: string, value: string): HTMLElement {
    return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value', style: 'font-size:18px' }, value));
  }

  function setProgress(phase: string, done: number, total: number): void {
    const pct = total ? Math.round((done / total) * 100) : 0;
    progressWrap.replaceChildren(
      h('div', { class: 'progress-label' }, h('span', {}, phase), h('span', {}, `${done}/${total} · ${pct}%`)),
      h('div', { class: 'progress' }, h('span', { style: `width:${pct}%` })),
    );
  }

  function renderResult(result: NonNullable<typeof lastResult>, pass: boolean): void {
    resultWrap.replaceChildren(
      h('div', { class: `stat ${pass ? 'good' : result.elapsedMs <= 10000 ? 'good' : 'warn'}` },
        h('div', { class: 'label' }, '最近一次导出耗时'),
        h('div', { class: 'value' }, `${(result.elapsedMs / 1000).toFixed(2)}`, h('span', { class: 'unit' }, 's')),
        h('div', { style: 'font-size:12px;color:var(--ink-soft);margin-top:5px' },
          `${result.width}×${result.height} px${result.size ? ` · ${formatBytes(result.size)}` : ''} · ${result.kind}`,
          result.kind === 'tiff' && scan.heightMm >= 999 ? h('strong', { class: pass ? 'acceptance-pass' : 'acceptance-fail', style: 'margin-left:8px' }, pass ? '达到 <10s 验收' : '超过 10s 目标（集显/大宽度可能变慢）') : null,
        ),
      ),
    );
  }

  async function exportTiff(): Promise<void> {
    busy = 'tiff'; render();
    const mask = createEditMask(scan, doc);
    try {
      const result = await renderWholeTiff(scan, doc.params, dpi, {
        tilePx: state.settings.tilePx || 1536,
        editSource: mask,
        onProgress: (p) => setProgress(p.phase, p.done, p.total),
      });
      downloadBlob(result.blob, `${scan.name}-${dpi}dpi.tif`);
      lastResult = { kind: 'tiff', elapsedMs: result.elapsedMs, width: result.width, height: result.height, size: result.blob.size };
      toast(`TIFF 已导出，耗时 ${(result.elapsedMs / 1000).toFixed(2)}s`, result.elapsedMs <= 10000 ? 'success' : 'warning', 6000);
    } catch (error) {
      console.error(error);
      toast(error instanceof Error ? error.message : 'TIFF 导出失败', 'error', 8000);
    } finally {
      busy = ''; progressWrap.replaceChildren(); render();
    }
  }

  async function exportZip(): Promise<void> {
    busy = 'zip'; render();
    const mask = createEditMask(scan, doc);
    try {
      const result = await exportCharacterZip(scan, doc.params, doc.boxes, dpi, {
        editSource: mask,
        onProgress: (p) => setProgress(p.phase, p.done, p.total),
      });
      downloadBlob(result.blob, `${scan.name}-单字-${dpi}dpi.zip`);
      lastResult = { kind: 'zip', elapsedMs: result.elapsedMs, width: 0, height: 0, size: result.blob.size };
      toast(`${result.count} 个单字与坐标已打包`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '单字导出失败', 'error', 8000);
    } finally {
      busy = ''; progressWrap.replaceChildren(); render();
    }
  }

  async function exportTable(): Promise<void> {
    busy = 'table'; render();
    const mask = createEditMask(scan, doc);
    try {
      const result = await renderCharacterTableTiff(scan, doc.params, doc.boxes, dpi, {
        editSource: mask,
        onProgress: (p) => setProgress(p.phase, p.done, p.total),
      });
      downloadBlob(result.blob, `${scan.name}-单字表-${dpi}dpi.tif`);
      lastResult = { kind: 'table', elapsedMs: result.elapsedMs, width: result.width, height: result.height, size: result.blob.size };
      toast('单字表 TIFF 已导出', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '单字表导出失败', 'error', 8000);
    } finally {
      busy = ''; progressWrap.replaceChildren(); render();
    }
  }

  function renderCoordTable(): void {
    const sorted = [...doc.boxes].sort((a, b) => a.index - b.index);
    coordWrap.replaceChildren(
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, '单字坐标')), h('span', { class: 'badge seal' }, `${sorted.length} 字`)),
      h('div', { class: 'card-body tight' },
        h('div', { class: 'table-wrap', style: 'max-height:560px' },
          h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', {}, '编号'), h('th', {}, '释字'), h('th', { class: 'num' }, '左 mm'), h('th', { class: 'num' }, '上 mm'), h('th', { class: 'num' }, '宽'), h('th', { class: 'num' }, '高'))),
            h('tbody', {}, ...sorted.map((b) => h('tr', {},
              h('td', {}, String(b.index)),
              h('td', {}, b.label),
              h('td', { class: 'num' }, (b.xMm - b.wMm / 2 + scan.widthMm / 2).toFixed(2)),
              h('td', { class: 'num' }, (scan.heightMm / 2 - (b.yMm + b.hMm / 2)).toFixed(2)),
              h('td', { class: 'num' }, b.wMm.toFixed(1)),
              h('td', { class: 'num' }, b.hMm.toFixed(1)),
            ))),
          ),
        ),
      ),
    );
  }

  render();
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  return bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
