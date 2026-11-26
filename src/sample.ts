import { db, uid } from './db';
import { addFreshDamage, createProceduralScan } from './geometry/procedural';
import type { Stele } from './types';

export async function ensureSampleData(onProgress?: (message: string, percent: number) => void): Promise<{ stele: Stele; created: boolean }> {
  const existing = await db.steles.list();
  if (existing.length) return { stele: existing[0], created: false };

  onProgress?.('建立碑刻档案', 8);
  const now = Date.now();
  const stele: Stele = {
    id: uid('stele'),
    name: '贞石样碑 · 楷书铭',
    dynasty: '唐（程序拟构）',
    era: '大和九年',
    yearNote: '测试样例，非真实文物；公元 835 年风格',
    heightMm: 1000,
    widthMm: 450,
    thicknessMm: 180,
    location: '碑林数字实验室 / 程序生成',
    material: '青石',
    description: '程序生成的阴刻楷书碑面，含整体倾斜、低频弯曲、石花、风化坑与后期新增泐损。',
    createdAt: now,
    updatedAt: now,
  };
  await db.steles.put(stele);

  onProgress?.('生成初刻三维网格（约 360 万三角面）', 28);
  await nextFrame();
  const first = createProceduralScan({
    steleId: stele.id,
    name: '初拓对应扫描 · 基础风化',
    seed: 20261127,
    extraDamage: false,
    createdAt: now - 86400000 * 30,
  });
  await db.scans.put(first);

  onProgress?.('生成复测扫描与新增泐损', 72);
  await nextFrame();
  const second = addFreshDamage(first);
  second.name = '近期复测扫描 · 局部新泐';
  await db.scans.put(second);

  const settings = await db.settings.get();
  settings.lastSteleId = stele.id;
  settings.lastScanId = second.id;
  await db.settings.put(settings);

  onProgress?.('完成', 100);
  return { stele, created: true };
}

export async function resetAndSeed(onProgress?: (message: string, percent: number) => void): Promise<Stele> {
  await db.reset();
  const result = await ensureSampleData(onProgress);
  return result.stele;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}
