export type HProps<K extends keyof HTMLElementTagNameMap = keyof HTMLElementTagNameMap> = {
  class?: string;
  dataset?: Record<string, string | number | boolean>;
  html?: string;
  style?: string | Partial<CSSStyleDeclaration> | Record<string, string | number>;
} & Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: HProps<K> = {},
  ...children: Array<Node | string | number | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: className, dataset, html, style, ...rest } = props as Record<string, unknown>;
  if (className) el.className = String(className);
  if (typeof style === 'string') el.setAttribute('style', style);
  else if (style && typeof style === 'object') Object.assign(el.style, style);
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      el.dataset[key] = String(value);
    }
  }
  if (html !== undefined) el.innerHTML = String(html);
  for (const [key, value] of Object.entries(rest)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'value' && el instanceof HTMLInputElement) {
      el.value = String(value);
    } else if (key === 'checked' && el instanceof HTMLInputElement) {
      el.checked = Boolean(value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function mount(el: HTMLElement, ...children: Node[]): void {
  clear(el);
  el.append(...children);
}

export function toast(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info', timeout = 3600): void {
  const root = document.querySelector<HTMLElement>('#toast-root');
  if (!root) return;
  const item = h('div', { class: `toast toast-${type}`, role: 'status' }, message);
  root.append(item);
  requestAnimationFrame(() => item.classList.add('show'));
  window.setTimeout(() => {
    item.classList.remove('show');
    window.setTimeout(() => item.remove(), 220);
  }, timeout);
}

export function modal(title: string, content: Node | string, actions?: HTMLElement): { close: () => void; root: HTMLElement } {
  const root = document.querySelector<HTMLElement>('#modal-root');
  if (!root) return { close: () => {}, root: document.body };
  const panel = h(
    'div',
    { class: 'modal-backdrop' },
    h(
      'div',
      { class: 'modal-panel', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', 'aria-label': '关闭', onclick: () => close() }, '×')),
      h('div', { class: 'modal-body' }, content instanceof Node ? content : h('div', { html: content })),
      actions ? h('div', { class: 'modal-foot' }, actions) : null,
    ),
  );
  const close = () => panel.remove();
  panel.addEventListener('click', (e) => {
    if (e.target === panel) close();
  });
  root.append(panel);
  return { close, root: panel };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.round(value));
}

export async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 180): (...args: A) => void {
  let timer = 0;
  return (...args: A) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}
