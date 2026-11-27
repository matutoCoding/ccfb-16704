// 极简 DOM 构建辅助
type ElProps<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps<K> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v as string;
    else if (k === 'style') el.setAttribute('style', v as string);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else {
      (el as unknown as Record<string, unknown>)[k] = v;
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(2),
): HTMLElement {
  const val = h('span', { class: 'value-tag', textContent: fmt(value) });
  const input = h('input', {
    type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
    oninput: () => {
      onInput(Number(input.value));
      val.textContent = fmt(Number(input.value));
    },
  }) as HTMLInputElement;
  return h('div', { class: 'row' }, h('label', { textContent: label }), input, val);
}
