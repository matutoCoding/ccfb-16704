import './styles.css';
import { store, type Route } from './state';
import { renderArchivePage } from './pages/archive';
import { renderScanPage } from './pages/scan';
import { renderRubbingPage } from './pages/rubbing';
import { renderCollatePage } from './pages/collate';
import { renderExportPage } from './pages/export';
import { renderSettingsPage } from './pages/settings';
import { h } from './ui/dom';
import { repo } from './db/repo';

const TABS: { route: Route; label: string }[] = [
  { route: 'archive', label: '碑刻档案' },
  { route: 'scan', label: '扫描处理' },
  { route: 'rubbing', label: '拓片生成' },
  { route: 'collate', label: '对比校勘' },
  { route: 'export', label: '出版导出' },
  { route: 'settings', label: '设置' },
];

async function bootstrap(): Promise<void> {
  const app = document.querySelector('#app')!;
  const steles = await repo.listSteles();
  const scans = await repo.listScans();
  store.update({ steles, scans });

  const tabBar = h('nav', { class: 'tabs' });
  const context = h('div', { class: 'context' });
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'brand', textContent: '碑刻数字拓片' }),
    tabBar,
    h('div', { class: 'spacer' }),
    context,
  );
  const main = h('main');
  app.append(header, main);

  function renderTabs(): void {
    tabBar.replaceChildren();
    for (const t of TABS) {
      tabBar.append(h('button', {
        class: store.get().route === t.route ? 'active' : '',
        textContent: t.label,
        onclick: () => store.update({ route: t.route }),
      }));
    }
    const stele = store.currentStele();
    const scan = store.currentScan();
    context.textContent = [stele?.name, scan?.label].filter(Boolean).join(' / ');
  }

  const renderers: Record<Route, (root: HTMLElement) => Promise<void>> = {
    archive: renderArchivePage,
    scan: renderScanPage,
    rubbing: renderRubbingPage,
    collate: renderCollatePage,
    export: renderExportPage,
    settings: renderSettingsPage,
  };

  let routing = false;
  let queued = false;
  async function route(): Promise<void> {
    if (routing) {
      queued = true; // 渲染过程中发生的路由切换，结束后再跑一次取最新状态
      return;
    }
    routing = true;
    try {
      renderTabs();
      main.replaceChildren();
      const page = h('div', { class: 'page' });
      main.append(page);
      try {
        await renderers[store.get().route](page);
      } catch (e) {
        console.error(e);
        page.append(h('div', { class: 'empty' }, h('div', { textContent: '页面出错：' + (e as Error).message })));
      }
      renderTabs();
    } finally {
      routing = false;
    }
    if (queued) {
      queued = false;
      await route();
    }
  }

  store.onRouteChange(() => route());
  await route();
}

bootstrap();
