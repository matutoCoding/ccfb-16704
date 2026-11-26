import { db } from './db';
import type { ID, RubbingDocument, Settings, Stele, ScanRecord } from './types';
import { DEFAULT_RUBBING_PARAMS } from './types';

export interface AppState {
  settings: Settings;
  steles: Stele[];
  scans: ScanRecord[];
  currentSteleId?: ID;
  currentScanId?: ID;
}

export const state: AppState = {
  settings: { id: 'app', defaultDpi: 600, tilePx: 4096, autoSeed: true, renderScale: 1 },
  steles: [],
  scans: [],
};

export async function loadState(): Promise<AppState> {
  state.settings = await db.settings.get();
  state.steles = await db.steles.list();
  state.scans = await db.scans.list();
  state.currentSteleId =
    state.settings.lastSteleId && state.steles.some((s) => s.id === state.settings.lastSteleId)
      ? state.settings.lastSteleId
      : state.steles[0]?.id;
  const steleScans = state.scans.filter((s) => s.steleId === state.currentSteleId);
  state.currentScanId =
    state.settings.lastScanId && steleScans.some((s) => s.id === state.settings.lastScanId)
      ? state.settings.lastScanId
      : steleScans[steleScans.length - 1]?.id;
  return state;
}

export function currentStele(): Stele | undefined {
  return state.steles.find((s) => s.id === state.currentSteleId);
}

export function currentScan(): ScanRecord | undefined {
  return state.scans.find((s) => s.id === state.currentScanId);
}

export async function selectStele(id: ID): Promise<void> {
  state.currentSteleId = id;
  const scans = state.scans.filter((s) => s.steleId === id);
  state.currentScanId = scans[scans.length - 1]?.id;
  state.settings.lastSteleId = id;
  state.settings.lastScanId = state.currentScanId;
  await db.settings.put(state.settings);
}

export async function selectScan(id: ID): Promise<void> {
  state.currentScanId = id;
  state.settings.lastScanId = id;
  await db.settings.put(state.settings);
}

export async function ensureRubbingDocument(scan: ScanRecord): Promise<RubbingDocument> {
  const docs = await db.rubbings.byStele(scan.steleId);
  const existing = docs.find((d) => d.scanId === scan.id);
  if (existing) return existing;
  const doc: RubbingDocument = {
    id: `rub_${scan.id}`,
    steleId: scan.steleId,
    scanId: scan.id,
    name: '默认拓片工作稿',
    params: { ...DEFAULT_RUBBING_PARAMS },
    strokes: [],
    boxes: scan.groundTruth?.glyphs.map((g) => ({
      id: `box_${g.id}`,
      index: g.index,
      label: g.char,
      xMm: g.xMm,
      yMm: g.yMm,
      wMm: g.wMm * 0.88,
      hMm: g.hMm * 0.88,
    })) ?? [],
    updatedAt: Date.now(),
  };
  await db.rubbings.put(doc);
  return doc;
}
