import type { PageId } from '../types';

export interface PageHandle {
  destroy?: () => void;
}

export interface PageContext {
  navigate: (page: PageId) => void;
}

export type PageRenderer = (view: HTMLElement, ctx: PageContext) => void | Promise<void | PageHandle> | PageHandle | void;
