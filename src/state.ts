// 全局应用状态：路由变化与数据变化分开通知，避免页面内 update 触发整页重渲染
import type { ScanRecord, SteleRecord } from './types';

export type Route = 'archive' | 'scan' | 'rubbing' | 'collate' | 'export' | 'settings';

export interface AppState {
  route: Route;
  steles: SteleRecord[];
  scans: ScanRecord[];
  currentSteleId: string | null;
  currentScanId: string | null;
}

type Listener = (s: AppState) => void;

const state: AppState = {
  route: 'archive',
  steles: [],
  scans: [],
  currentSteleId: null,
  currentScanId: null,
};

const routeListeners = new Set<Listener>();
const dataListeners = new Set<Listener>();

export const store = {
  get(): AppState {
    return state;
  },
  /** route 变更 -> 整页重渲染；其余字段变更 -> 仅数据事件 */
  update(patch: Partial<AppState>): boolean {
    const routeChanged = patch.route !== undefined && patch.route !== state.route;
    Object.assign(state, patch);
    if (routeChanged) routeListeners.forEach((l) => l(state));
    else dataListeners.forEach((l) => l(state));
    return routeChanged;
  },
  onRouteChange(l: Listener): () => void {
    routeListeners.add(l);
    return () => routeListeners.delete(l);
  },
  onDataChange(l: Listener): () => void {
    dataListeners.add(l);
    return () => dataListeners.delete(l);
  },
  currentStele(): SteleRecord | undefined {
    return state.steles.find((s) => s.id === state.currentSteleId);
  },
  currentScan(): ScanRecord | undefined {
    return state.scans.find((s) => s.id === state.currentScanId);
  },
};

let toastTimer: number | undefined;
export function toast(msg: string): void {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 2600);
}

export function showProgress(text: string, pct: number): HTMLDivElement {
  let el = document.querySelector<HTMLDivElement>('.progress');
  if (!el) {
    el = document.createElement('div');
    el.className = 'progress';
    el.innerHTML = `<div class="ptext"></div><div class="bar"><i style="width:0"></i></div>`;
    document.body.appendChild(el);
  }
  el.querySelector('.ptext')!.textContent = text;
  el.querySelector('.bar i')!.setAttribute('style', `width:${Math.round(pct * 100)}%`);
  return el;
}
export function hideProgress(): void {
  document.querySelector('.progress')?.remove();
}
