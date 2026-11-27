import {
  AppSettings,
  CharacterBox,
  DEFAULT_SETTINGS,
  Registration,
  RetouchStroke,
  RubbingParams,
  ScanRecord,
  SteleRecord,
  uid,
} from '../types';
import { blobStore, kv } from './idb';

const K = {
  steles: 'repo:steles',
  scans: 'repo:scans',
  params: (scanId: string) => `rubbing:params:${scanId}`,
  strokes: (scanId: string) => `rubbing:strokes:${scanId}`,
  chars: (scanId: string) => `rubbing:chars:${scanId}`,
  reg: (scanId: string) => `rubbing:registration:${scanId}`,
  oldPhoto: (scanId: string) => `blob:oldphoto:${scanId}`,
  heightfield: (scanId: string) => `blob:heightfield:${scanId}`,
  settings: 'app:settings',
};

async function loadList<T>(key: string): Promise<T[]> {
  return (await kv.get<T[]>(key)) ?? [];
}

export const repo = {
  // ---------- 碑刻档案 ----------
  async listSteles(): Promise<SteleRecord[]> {
    return loadList<SteleRecord>(K.steles);
  },
  async saveStele(rec: SteleRecord): Promise<void> {
    const list = await loadList<SteleRecord>(K.steles);
    const i = list.findIndex((s) => s.id === rec.id);
    rec.updatedAt = Date.now();
    if (i >= 0) list[i] = rec;
    else list.push(rec);
    await kv.set(K.steles, list);
  },
  async deleteStele(id: string): Promise<void> {
    const scans = await this.listScans(id);
    for (const sc of scans) await this.deleteScan(sc.id);
    await kv.set(K.steles, (await loadList<SteleRecord>(K.steles)).filter((s) => s.id !== id));
  },

  // ---------- 扫描 ----------
  async listScans(steleId?: string): Promise<ScanRecord[]> {
    const all = await loadList<ScanRecord>(K.scans);
    return steleId ? all.filter((s) => s.steleId === steleId) : all;
  },
  async getScan(id: string): Promise<ScanRecord | undefined> {
    return (await loadList<ScanRecord>(K.scans)).find((s) => s.id === id);
  },
  async saveScan(rec: ScanRecord): Promise<void> {
    const list = await loadList<ScanRecord>(K.scans);
    const i = list.findIndex((s) => s.id === rec.id);
    if (i >= 0) list[i] = rec;
    else list.push(rec);
    await kv.set(K.scans, list);
  },
  async deleteScan(id: string): Promise<void> {
    await kv.set(K.scans, (await loadList<ScanRecord>(K.scans)).filter((s) => s.id !== id));
    await Promise.all(
      [K.params(id), K.strokes(id), K.chars(id), K.reg(id)].map((k) => kv.remove(k)),
    );
    await blobStore.remove(K.oldPhoto(id)).catch(() => undefined);
    await blobStore.remove(K.heightfield(id)).catch(() => undefined);
  },

  // ---------- 高度场（二进制大对象） ----------
  async saveHeightField(scanId: string, hf: {
    data: Float32Array;
    widthPx: number;
    heightPx: number;
    pxPerMm: number;
    widthMm: number;
    heightMm: number;
  }): Promise<void> {
    const header = new Uint32Array(4);
    header[0] = hf.widthPx;
    header[1] = hf.heightPx;
    const meta = new Float64Array(3);
    meta[0] = hf.pxPerMm;
    meta[1] = hf.widthMm;
    meta[2] = hf.heightMm;
    const blob = new Blob([header.buffer as ArrayBuffer, meta.buffer as ArrayBuffer, hf.data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    await blobStore.put(K.heightfield(scanId), blob);
  },
  async loadHeightField(scanId: string) {
    const blob = await blobStore.get(K.heightfield(scanId));
    if (!blob) return null;
    const buf = await blob.arrayBuffer();
    const header = new Uint32Array(buf, 0, 4);
    const meta = new Float64Array(buf, 16, 3);
    const data = new Float32Array(buf, 16 + 24);
    return {
      data,
      widthPx: header[0],
      heightPx: header[1],
      pxPerMm: meta[0],
      widthMm: meta[1],
      heightMm: meta[2],
    };
  },

  // ---------- 拓片参数 / 补墨 ----------
  async getParams(scanId: string, fallback: RubbingParams): Promise<RubbingParams> {
    return (await kv.get<RubbingParams>(K.params(scanId))) ?? structuredClone(fallback);
  },
  async saveParams(scanId: string, p: RubbingParams): Promise<void> {
    await kv.set(K.params(scanId), p);
  },
  async getStrokes(scanId: string): Promise<RetouchStroke[]> {
    return (await kv.get<RetouchStroke[]>(K.strokes(scanId))) ?? [];
  },
  async saveStrokes(scanId: string, strokes: RetouchStroke[]): Promise<void> {
    await kv.set(K.strokes(scanId), strokes);
  },

  // ---------- 单字框选 ----------
  async getCharacters(scanId: string): Promise<CharacterBox[]> {
    return (await kv.get<CharacterBox[]>(K.chars(scanId))) ?? [];
  },
  async saveCharacters(scanId: string, chars: CharacterBox[]): Promise<void> {
    await kv.set(K.chars(scanId), chars);
  },

  // ---------- 对比校勘 ----------
  async saveOldPhoto(scanId: string, blob: Blob): Promise<void> {
    await blobStore.put(K.oldPhoto(scanId), blob);
  },
  async loadOldPhoto(scanId: string): Promise<Blob | null> {
    return (await blobStore.get(K.oldPhoto(scanId))) ?? null;
  },
  async getRegistration(scanId: string): Promise<Registration | null> {
    return (await kv.get<Registration>(K.reg(scanId))) ?? null;
  },
  async saveRegistration(scanId: string, reg: Registration): Promise<void> {
    await kv.set(K.reg(scanId), reg);
  },

  // ---------- 设置 ----------
  async getSettings(): Promise<AppSettings> {
    return { ...structuredClone(DEFAULT_SETTINGS), ...((await kv.get<AppSettings>(K.settings)) ?? {}) };
  },
  async saveSettings(s: AppSettings): Promise<void> {
    await kv.set(K.settings, s);
  },
};

export function newSteleId(): string {
  return uid('stele');
}
export function newScanId(): string {
  return uid('scan');
}
