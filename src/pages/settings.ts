// 设置页：DPI、分块、墨色/纸色、数据管理
import { repo } from '../db/repo';
import { hideProgress, showProgress, toast } from '../state';
import { clear, h } from '../ui/dom';
import { DEFAULT_SETTINGS } from '../types';

export async function renderSettingsPage(root: HTMLElement): Promise<void> {
  clear(root);
  const settings = await repo.getSettings();
  const wrap = h('div', { class: 'scroll', style: 'width:100%' });
  const card = h('div', { class: 'card', style: 'max-width:640px' });

  const dpi = h('input', { type: 'number', min: '72', max: '1200', value: String(settings.defaultDpi) }) as HTMLInputElement;
  const tile = h('input', { type: 'number', min: '256', max: '4096', step: '256', value: String(settings.gpuTileSize) }) as HTMLInputElement;
  const maxPx = h('input', { type: 'number', min: '262144', step: '262144', value: String(settings.maxScreenPixels) }) as HTMLInputElement;
  const ink = h('input', { type: 'color', value: settings.inkDark }) as HTMLInputElement;
  const paper = h('input', { type: 'color', value: settings.paperLight }) as HTMLInputElement;

  card.append(
    h('div', { class: 'section-title', textContent: '系统设置' }),
    row('默认 DPI', dpi),
    row('GPU 分块边长', tile),
    row('屏幕预览上限像素', maxPx),
    row('墨色', ink),
    row('纸色', paper),
    h('div', { class: 'btn-row', style: 'margin-top:14px' },
      h('button', {
        class: 'btn', textContent: '保存设置', onclick: async () => {
          settings.defaultDpi = Number(dpi.value);
          settings.gpuTileSize = Number(tile.value);
          settings.maxScreenPixels = Number(maxPx.value);
          settings.inkDark = ink.value;
          settings.paperLight = paper.value;
          await repo.saveSettings(settings);
          toast('设置已保存');
        },
      }),
      h('button', {
        class: 'btn ghost', textContent: '恢复默认', onclick: async () => {
          await repo.saveSettings({ ...DEFAULT_SETTINGS });
          renderSettingsPage(root);
        },
      })),
  );
  wrap.append(card);

  // 数据管理
  const steles = await repo.listSteles();
  const scans = await repo.listScans();
  const dataCard = h('div', { class: 'card', style: 'max-width:640px' },
    h('h3', { textContent: '本地数据（IndexedDB）' }),
    h('div', { class: 'metric' }, h('span', { textContent: '碑刻档案' }), h('b', { textContent: String(steles.length) })),
    h('div', { class: 'metric' }, h('span', { textContent: '扫描记录（含高度场）' }), h('b', { textContent: String(scans.length) })),
    h('div', { class: 'muted', style: 'margin:8px 0', textContent: '所有网格与高度场仅保存在本浏览器，不上传服务器。' }),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn danger', textContent: '清空全部数据', onclick: async () => {
          if (!confirm('将删除全部碑刻、扫描、高度场、补墨与单字数据，且不可恢复。继续？')) return;
          showProgress('清库中…', 0.5);
          await new Promise<void>((resolve, reject) => {
            const r = indexedDB.deleteDatabase('stele-rubbing-db');
            r.onsuccess = () => resolve();
            r.onerror = () => reject(r.error);
            r.onblocked = () => reject(new Error('数据库被占用，请刷新页面后重试'));
          });
          hideProgress();
          toast('已清空，刷新后生效');
          setTimeout(() => location.reload(), 800);
        },
      }),
      h('button', {
        class: 'btn ghost', textContent: '估算存储占用', onclick: async () => {
          if (navigator.storage?.estimate) {
            const est = await navigator.storage.estimate();
            toast(`已用约 ${((est.usage ?? 0) / 1048576).toFixed(1)} MB / 配额 ${((est.quota ?? 0) / 1073741824).toFixed(1)} GB`);
          } else toast('当前浏览器不支持存储估算');
        },
      }),
    ),
  );
  wrap.append(dataCard);

  const about = h('div', { class: 'card', style: 'max-width:640px' },
    h('h3', { textContent: '关于' }),
    h('div', { class: 'muted', textContent: '碑刻数字拓片系统 · TypeScript + WebGL2 + GLSL · 墨包物理模型（高斯上包络）' }),
    h('div', { class: 'muted', style: 'margin-top:6px', textContent: '验收口径：笔画边界与网格真值刻口偏差 < 0.2mm；1m 碑 600DPI 全图 10s 内完成。' }),
  );
  wrap.append(about);
  root.append(wrap);
}

function row(label: string, input: HTMLElement): HTMLElement {
  return h('div', { class: 'row' }, h('label', { textContent: label }), input);
}
