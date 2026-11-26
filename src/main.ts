import './styles.css';
import { h, mount, toast } from './ui/dom';
import { loadState, state } from './state';
import { ensureSampleData } from './sample';
import type { PageId } from './types';
import { renderArchive } from './pages/archive';
import { renderScan } from './pages/scan';
import { renderRubbing } from './pages/rubbing';
import { renderCompare } from './pages/compare';
import { renderExport } from './pages/export';
import { renderSettings } from './pages/settings';
import type { PageContext, PageHandle } from './pages/types';

const NAV: Array<{ id: PageId; label: string; icon: string; subtitle: string }> = [
  { id: 'archive', label: '碑刻档案', icon: '碑', subtitle: '碑刻元数据与多次扫描归档' },
  { id: 'scan', label: '扫描处理', icon: '三维', subtitle: 'PLY / OBJ 导入、基准面拟合与几何检查' },
  { id: 'rubbing', label: '拓片生成', icon: '拓', subtitle: '墨包轻拍、乌金 / 蝉翼、补墨与单字框选' },
  { id: 'compare', label: '对比校勘', icon: '勘', subtitle: '老拓片自动配准、差异区域与泐损高亮' },
  { id: 'export', label: '出版导出', icon: '版', subtitle: '指定 DPI 的 TIFF、单字 ZIP 与坐标表' },
  { id: 'settings', label: '设置验收', icon: '设', subtitle: 'IndexedDB、渲染参数、精度与性能验收' },
];

let currentHandle: PageHandle | undefined;

async function bootstrap(): Promise<void> {
  renderNav('archive');
  const view = document.querySelector<HTMLElement>('#view')!;
  mount(view, h('div', { class: 'empty-state' }, h('div', { class: 'big-icon' }, '碑'), h('h3', {}, '正在打开本地碑库…'), h('p', {}, '初始化 IndexedDB 与样例数据')));
  try {
    await loadState();
    updateStorageState();
    if (state.settings.autoSeed && state.steles.length === 0) {
      await seedWithOverlay();
      await loadState();
    }
    window.addEventListener('hashchange', renderRouteFromHash);
    if (!location.hash) history.replaceState(null, '', '#/archive');
    await renderRouteFromHash();
  } catch (error) {
    console.error(error);
    mount(view, h('div', { class: 'empty-state' }, h('h3', {}, '初始化失败'), h('p', {}, error instanceof Error ? error.message : String(error))));
  }
}

function renderNav(active: PageId): void {
  const nav = document.querySelector<HTMLElement>('#nav')!;
  nav.replaceChildren(
    ...NAV.map((item) =>
      h(
        'button',
        {
          class: `nav-item ${item.id === active ? 'active' : ''}`,
          onclick: () => {
            location.hash = `/${item.id}`;
          },
        },
        h('span', { class: 'nav-icon' }, item.icon),
        h('span', {}, item.label),
      ),
    ),
  );
}

let routeSequence = 0;

function pageFromHash(): PageId {
  const page = location.hash.replace(/^#\//, '') as PageId;
  return NAV.some((n) => n.id === page) ? page : 'archive';
}

function navigate(page: PageId): void {
  if (pageFromHash() === page) {
    void renderRoute(page);
  } else {
    location.hash = `/${page}`;
  }
}

function renderRouteFromHash(): Promise<void> {
  return renderRoute(pageFromHash());
}

async function renderRoute(page: PageId): Promise<void> {
  const routeId = ++routeSequence;
  renderNav(page);
  const meta = NAV.find((n) => n.id === page)!;
  document.querySelector<HTMLElement>('#page-title')!.textContent = meta.label;
  document.querySelector<HTMLElement>('#page-subtitle')!.textContent = meta.subtitle;
  const view = document.querySelector<HTMLElement>('#view')!;
  currentHandle?.destroy?.();
  currentHandle = undefined;
  view.scrollTop = 0;
  view.replaceChildren();
  const ctx: PageContext = { navigate };
  try {
    let handle: PageHandle | void | undefined;
    switch (page) {
      case 'archive': handle = await renderArchive(view, ctx); break;
      case 'scan': handle = await renderScan(view, ctx); break;
      case 'rubbing': handle = await renderRubbing(view, ctx); break;
      case 'compare': handle = await renderCompare(view, ctx); break;
      case 'export': handle = await renderExport(view, ctx); break;
      case 'settings': handle = await renderSettings(view, ctx); break;
    }
    if (routeId !== routeSequence) {
      handle?.destroy?.();
      return;
    }
    currentHandle = handle || undefined;
  } catch (error) {
    console.error(error);
    if (routeId !== routeSequence) return;
    mount(
      view,
      h('div', { class: 'empty-state' },
        h('div', { class: 'big-icon' }, '⚠'),
        h('h3', {}, '页面运行出错'),
        h('p', {}, error instanceof Error ? error.stack ?? error.message : String(error)),
        h('button', { class: 'btn primary', onclick: () => renderRoute(page) }, '重试'),
      ),
    );
  }
}

async function seedWithOverlay(): Promise<void> {
  const view = document.querySelector<HTMLElement>('#view')!;
  const bar = h('span', { style: 'width:0%' });
  const label = h('span', {}, '准备生成样例');
  mount(
    view,
    h('div', { class: 'empty-state' },
      h('div', { class: 'big-icon' }, '石'),
      h('h3', {}, '正在凿刻程序样碑'),
      h('p', {}, '生成带阴刻楷书、弯曲基准面和风化坑的数百万面网格，数据仅保存在本机 IndexedDB。'),
      h('div', { style: 'width:min(520px,90vw)' },
        h('div', { class: 'progress-label' }, label, h('span', { id: 'seed-percent' }, '0%')),
        h('div', { class: 'progress' }, bar),
      ),
    ),
  );
  await ensureSampleData((message, percent) => {
    label.textContent = message;
    bar.style.width = `${percent}%`;
    const pct = document.querySelector<HTMLElement>('#seed-percent');
    if (pct) pct.textContent = `${percent}%`;
  });
  toast('样例碑刻与两次扫描已保存到 IndexedDB', 'success');
}

async function updateStorageState(): Promise<void> {
  const el = document.querySelector<HTMLElement>('#storage-state');
  if (!el) return;
  try {
    const estimate = await navigator.storage?.estimate?.();
    const mb = estimate?.usage ? (estimate.usage / 1024 / 1024).toFixed(1) : '0';
    el.textContent = `IndexedDB 本地碑库 · 已用 ${mb} MB`;
  } catch {
    el.textContent = 'IndexedDB 本地碑库';
  }
}

bootstrap();
